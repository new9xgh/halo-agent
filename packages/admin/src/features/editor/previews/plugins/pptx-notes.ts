/**
 * pptx (OPC zip) parsing helpers for the preview plugin: speaker-notes
 * extraction + a Content_Types repair pass for decks pptx-preview chokes on.
 *
 * `pptx-preview` doesn't expose notes, so we parse them ourselves with jszip +
 * DOMParser. Slide order comes from `ppt/presentation.xml`'s <p:sldIdLst>
 * resolved through the presentation rels — NOT from slideN.xml filename order,
 * which is not guaranteed to match play order.
 *
 * All XML matching is by localName (the files are heavily namespaced;
 * prefix-based querySelector is unreliable across producers).
 */

import JSZip from 'jszip'

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Direct child elements with the given localName, in document order. */
function childElements(el: Element, localName: string): Element[] {
  const out: Element[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i]
    if (n.nodeType === 1 && (n as Element).localName === localName) out.push(n as Element)
  }
  return out
}

/** All descendant elements with the given localName, in document order. */
function descendants(el: Element, localName: string): Element[] {
  const out: Element[] = []
  const walk = (node: Node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i]
      if (n.nodeType !== 1) continue
      if ((n as Element).localName === localName) out.push(n as Element)
      walk(n)
    }
  }
  walk(el)
  return out
}

/** Resolve a rels Target ("../notesSlides/notesSlide1.xml") against a zip dir. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1) // absolute OPC part name
  const parts = baseDir.split('/')
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * Full text of one <a:p> paragraph: concatenates every <a:t> in document order
 * (runs split by formatting, fields, …) and turns <a:br/> into '\n'. Style is
 * dropped, characters are not.
 */
function paragraphText(p: Element): string {
  let out = ''
  const walk = (node: Node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i]
      if (n.nodeType !== 1) continue
      const el = n as Element
      if (el.localName === 't') out += el.textContent ?? ''
      else if (el.localName === 'br') out += '\n'
      else walk(el)
    }
  }
  walk(p)
  return out
}

/**
 * Text of the notes body placeholder in a notesSlide document: the <p:sp>
 * whose <p:ph type="body"> — sldImg / slideNum placeholders are skipped by the
 * type check. Paragraphs joined with '\n'.
 */
function notesBodyText(doc: Document): string {
  for (const sp of descendants(doc.documentElement, 'sp')) {
    const ph = descendants(sp, 'ph')[0]
    if (ph?.getAttribute('type') !== 'body') continue
    const txBody = descendants(sp, 'txBody')[0]
    if (!txBody) return ''
    return descendants(txBody, 'p').map(paragraphText).join('\n')
  }
  return ''
}

export interface PptxNotes {
  /** Speaker notes per slide, presentation (play) order; '' = no notes. */
  texts: string[]
  /**
   * DOM child index of each play-order slide in pptx-preview's list render.
   * pptx-preview sorts slides by the number in the part filename (slideN.xml),
   * which diverges from sldIdLst play order once slides have been reordered —
   * PowerPoint reorders sldIdLst but never renames the parts.
   */
  domIndex: number[]
}

/**
 * Extract speaker notes for every slide, in presentation (play) order.
 * Throws on a broken zip / missing presentation parts — callers treat any
 * failure as "no notes".
 */
export async function extractPptxNotes(buf: ArrayBuffer): Promise<PptxNotes> {
  const zip = await JSZip.loadAsync(buf)
  const parser = new DOMParser()
  const readXml = async (path: string): Promise<Document | null> => {
    const file = zip.file(path)
    if (!file) return null
    return parser.parseFromString(await file.async('text'), 'application/xml')
  }

  const pres = await readXml('ppt/presentation.xml')
  const presRels = await readXml('ppt/_rels/presentation.xml.rels')
  if (!pres || !presRels) throw new Error('missing presentation.xml or its rels')

  const relTarget = new Map<string, string>()
  for (const rel of descendants(presRels.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) relTarget.set(id, target)
  }

  const sldIdLst = descendants(pres.documentElement, 'sldIdLst')[0]
  if (!sldIdLst) return { texts: [], domIndex: [] }
  const slidePaths: string[] = []
  for (const sldId of childElements(sldIdLst, 'sldId')) {
    const rId = sldId.getAttributeNS(R_NS, 'id')
    const target = rId ? relTarget.get(rId) : undefined
    if (target) slidePaths.push(resolveTarget('ppt', target))
  }

  const texts: string[] = []
  for (const slidePath of slidePaths) {
    const dir = slidePath.slice(0, slidePath.lastIndexOf('/'))
    const base = slidePath.slice(slidePath.lastIndexOf('/') + 1)
    const rels = await readXml(`${dir}/_rels/${base}.rels`)
    let text = ''
    if (rels) {
      const rel = descendants(rels.documentElement, 'Relationship').find((r) =>
        (r.getAttribute('Type') ?? '').endsWith('/notesSlide'),
      )
      const target = rel?.getAttribute('Target')
      if (target) {
        const notesDoc = await readXml(resolveTarget(dir, target))
        if (notesDoc) text = notesBodyText(notesDoc)
      }
    }
    texts.push(text)
  }

  // Map play order → DOM order (pptx-preview renders sorted by the numeric
  // suffix of the part filename; see PptxNotes.domIndex).
  const fileNum = (p: string) => parseInt(/(\d+)/.exec(p.slice(p.lastIndexOf('/') + 1))?.[0] ?? '1', 10)
  const domOrder = slidePaths.map((p, i) => ({ i, n: fileNum(p) })).sort((a, b) => a.n - b.n)
  const domIndex: number[] = new Array(slidePaths.length)
  domOrder.forEach((entry, pos) => { domIndex[entry.i] = pos })

  return { texts, domIndex }
}

/**
 * Workaround for decks whose [Content_Types].xml declares Override parts that
 * don't exist in the package (seen in the wild: a WPS-exported deck listing 34
 * slideMaster overrides with a single actual master). pptx-preview's
 * _loadContentTypes does `files[part].async()` with no existence check; the
 * TypeError is swallowed by its catch-all, so load() resolves with 0 slides
 * and the preview is a silent black rectangle. Real fix belongs upstream in
 * pptx-preview; until then, drop the dangling overrides so its loader never
 * touches a missing part.
 *
 * Returns a rebuilt buffer when a repair was needed, or null when the package
 * is consistent (caller keeps the original buffer — no re-zip cost).
 */
export async function repairPptxContentTypes(buf: ArrayBuffer): Promise<ArrayBuffer | null> {
  const zip = await JSZip.loadAsync(buf)
  const ctPath = '[Content_Types].xml'
  const ctFile = zip.file(ctPath)
  if (!ctFile) return null
  const doc = new DOMParser().parseFromString(await ctFile.async('text'), 'application/xml')
  const dangling = descendants(doc.documentElement, 'Override').filter((o) => {
    const part = o.getAttribute('PartName')
    return part !== null && !zip.file(part.replace(/^\//, ''))
  })
  if (dangling.length === 0) return null
  console.warn(`[PptxPreview] repairing ${dangling.length} dangling Content_Types override(s)`)
  for (const o of dangling) o.parentNode?.removeChild(o)
  zip.file(ctPath, new XMLSerializer().serializeToString(doc))
  return zip.generateAsync({ type: 'arraybuffer' })
}
