import fs from 'node:fs'
import path from 'node:path'
import { IMAGE_EXTS, imageMimeFromExt } from '@turmind/halo-core'

const MAX_FILE_BYTES = 100 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface ResolvedInput {
  text: string
  images: Array<{ data: string; mimeType: string }>
  attachments: string[]
  warnings: string[]
}

// Matches @file or @image followed by a quoted or unquoted path
const REF_PATTERN = /@(file|image)\s+(?:"([^"]+)"|(\S+))/g

export function resolveRefs(input: string, workspace: string): ResolvedInput {
  const images: ResolvedInput['images'] = []
  const attachments: string[] = []
  const warnings: string[] = []
  const parts: string[] = []

  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = REF_PATTERN.exec(input)) !== null) {
    parts.push(input.slice(lastIdx, match.index))
    lastIdx = match.index + match[0].length
    const kind = match[1] as 'file' | 'image'
    const rawPath = match[2] ?? match[3]
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspace, rawPath)
    const ext = path.extname(resolved).toLowerCase()

    // statSync directly (no existsSync pre-check): closes the check-then-use
    // window — a path that vanishes concurrently degrades to [not found]
    // instead of throwing mid-send.
    let stat: fs.Stats | null = null
    try { stat = fs.statSync(resolved) } catch { /* ENOENT et al → not found */ }
    if (!stat) {
      parts.push(`[not found: ${rawPath}]`)
      continue
    }
    if (!stat.isFile()) {
      parts.push(`[not a file: ${rawPath}]`)
      continue
    }

    const isImage = kind === 'image' || IMAGE_EXTS.has(ext)
    try {
      if (isImage) {
        if (stat.size > MAX_IMAGE_BYTES) {
          warnings.push(`${rawPath}: image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_IMAGE_BYTES / 1024 / 1024}MB), skipped`)
          continue
        }
        const data = fs.readFileSync(resolved).toString('base64')
        // Explicit `@image foo.tiff` forces the image path even for an ext the
        // table doesn't know — tag it octet-stream and let the model reject it,
        // as before.
        images.push({ data, mimeType: imageMimeFromExt(ext) ?? 'application/octet-stream' })
      } else {
        const relPath = path.relative(workspace, resolved)
        if (stat.size > MAX_FILE_BYTES) {
          // Byte-accurate truncation: read only the first MAX_FILE_BYTES bytes.
          // String .slice counts UTF-16 code units, which over-read multi-byte
          // text and could split a surrogate pair. A partial UTF-8 sequence at
          // the cut decodes to U+FFFD — strip it.
          const buf = Buffer.alloc(MAX_FILE_BYTES)
          const fd = fs.openSync(resolved, 'r')
          let n = 0
          try { n = fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0) } finally { fs.closeSync(fd) }
          const content = buf.subarray(0, n).toString('utf-8').replace(/\uFFFD+$/, '')
          parts.push(`\n<file path="${relPath}">\n${content}\n[truncated: file is ${(stat.size / 1024).toFixed(0)}KB, showing first ${MAX_FILE_BYTES / 1024}KB]\n</file>\n`)
          warnings.push(`${rawPath}: truncated (${(stat.size / 1024).toFixed(0)}KB, max ${MAX_FILE_BYTES / 1024}KB)`)
        } else {
          const content = fs.readFileSync(resolved, 'utf-8')
          parts.push(`\n<file path="${relPath}">\n${content}\n</file>\n`)
        }
      }
    } catch {
      // File deleted between stat and read (TOCTOU) — same visible
      // degradation as a missing path, never a throw mid-send.
      parts.push(`[not found: ${rawPath}]`)
      continue
    }
    attachments.push(rawPath)
  }

  REF_PATTERN.lastIndex = 0
  parts.push(input.slice(lastIdx))
  return { text: parts.join('').trim(), images, attachments, warnings }
}
