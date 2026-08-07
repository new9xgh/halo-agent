import { describe, it, expect, beforeEach } from 'vitest'
import { createEditorStore, type EditorStoreApi, type FileTreeNode } from '../src/shared/stores/editor-store'

/**
 * Contract: the file-tree mutators (insertFileNode / removeFileNode /
 * setDirChildren) use structural sharing — they clone only the nodes on the
 * path from the root to the mutation point and keep every other subtree's
 * object identity. This matters because they run per `file:changed` WS event
 * (twice on the default store: file-handlers.ts + use-file-tree.ts), and the
 * previous whole-tree JSON deep clone per event stalled the main thread on
 * large workspaces during agent build storms (audit C-M2).
 *
 * Corollary: true no-ops (duplicate insert, remove of a missing node) return
 * the state object unchanged, so zustand's Object.is check skips subscriber
 * notification entirely — which is what de-fangs the double-write.
 */

function findNode(root: FileTreeNode, path: string): FileTreeNode | undefined {
  const parts = path.split('/').filter(Boolean)
  let cur: FileTreeNode | undefined = root
  for (const part of parts) {
    cur = cur?.children?.find((c) => c.name === part)
    if (!cur) return undefined
  }
  return cur
}

/**
 * root ''
 * ├── docs/            (loaded: readme.md)
 * ├── lazy/            (never loaded: children undefined, hasChildren false)
 * └── src/             (loaded)
 *     ├── a.ts
 *     └── sub/         (loaded: b.ts)
 */
function seedTree(store: EditorStoreApi): void {
  store.getState().setFileTree({
    name: 'root',
    path: '',
    type: 'directory',
    hasChildren: true,
    children: [
      {
        name: 'docs', path: 'docs', type: 'directory', hasChildren: true,
        children: [{ name: 'readme.md', path: 'docs/readme.md', type: 'file' }],
      },
      { name: 'lazy', path: 'lazy', type: 'directory', hasChildren: false },
      {
        name: 'src', path: 'src', type: 'directory', hasChildren: true,
        children: [
          { name: 'a.ts', path: 'src/a.ts', type: 'file' },
          {
            name: 'sub', path: 'src/sub', type: 'directory', hasChildren: true,
            children: [{ name: 'b.ts', path: 'src/sub/b.ts', type: 'file' }],
          },
        ],
      },
    ],
  })
}

let store: EditorStoreApi

beforeEach(() => {
  store = createEditorStore()
  seedTree(store)
})

function tree(): FileTreeNode {
  return store.getState().fileTree!
}

describe('insertFileNode structural sharing', () => {
  it('clones only the root→parent spine; sibling subtrees keep identity', () => {
    const before = tree()
    const docsBefore = findNode(before, 'docs')!
    const lazyBefore = findNode(before, 'lazy')!
    const subBefore = findNode(before, 'src/sub')!
    const aBefore = findNode(before, 'src/a.ts')!

    store.getState().insertFileNode('src/new.ts')

    const after = tree()
    // Changed path: new identities.
    expect(after).not.toBe(before)
    expect(findNode(after, 'src')).not.toBe(findNode(before, 'src'))
    expect(findNode(after, 'src/new.ts')).toBeDefined()
    // Untouched subtrees: same objects.
    expect(findNode(after, 'docs')).toBe(docsBefore)
    expect(findNode(after, 'lazy')).toBe(lazyBefore)
    expect(findNode(after, 'src/sub')).toBe(subBefore)
    expect(findNode(after, 'src/a.ts')).toBe(aBefore)
    // The pre-mutation tree itself was not mutated in place.
    expect(findNode(before, 'src/new.ts')).toBeUndefined()
  })

  it('nested insert clones the whole spine, keeps off-spine leaves', () => {
    const before = tree()
    store.getState().insertFileNode('src/sub/c.ts')
    const after = tree()

    expect(after).not.toBe(before)
    expect(findNode(after, 'src')).not.toBe(findNode(before, 'src'))
    expect(findNode(after, 'src/sub')).not.toBe(findNode(before, 'src/sub'))
    expect(findNode(after, 'src/sub/c.ts')).toBeDefined()
    expect(findNode(after, 'docs')).toBe(findNode(before, 'docs'))
    expect(findNode(after, 'src/a.ts')).toBe(findNode(before, 'src/a.ts'))
    expect(findNode(after, 'src/sub/b.ts')).toBe(findNode(before, 'src/sub/b.ts'))
  })

  it('duplicate insert is a full no-op: state object unchanged (subscribers skipped)', () => {
    store.getState().insertFileNode('src/new.ts')
    const before = tree()
    // The second write of the double-subscribe (file-handlers + use-file-tree).
    store.getState().insertFileNode('src/new.ts')
    expect(tree()).toBe(before)
  })

  it('insert under a never-loaded dir flips hasChildren without touching siblings', () => {
    const before = tree()
    store.getState().insertFileNode('lazy/inside.ts')
    const after = tree()

    expect(after).not.toBe(before)
    const lazyAfter = findNode(after, 'lazy')!
    expect(lazyAfter.hasChildren).toBe(true)
    expect(lazyAfter.children).toBeUndefined() // still not loaded — lazy-load stays armed
    expect(findNode(after, 'docs')).toBe(findNode(before, 'docs'))
    expect(findNode(after, 'src')).toBe(findNode(before, 'src'))

    // Already flipped → pure no-op.
    store.getState().insertFileNode('lazy/other.ts')
    expect(tree()).toBe(after)
  })

  it('insert under a missing dir is a no-op', () => {
    const before = tree()
    store.getState().insertFileNode('src/nope/x.ts')
    expect(tree()).toBe(before)
  })
})

describe('removeFileNode structural sharing', () => {
  it('clones only the spine; sibling subtrees keep identity', () => {
    const before = tree()
    const docsBefore = findNode(before, 'docs')!
    const subBefore = findNode(before, 'src/sub')!

    store.getState().removeFileNode('src/a.ts')

    const after = tree()
    expect(after).not.toBe(before)
    expect(findNode(after, 'src')).not.toBe(findNode(before, 'src'))
    expect(findNode(after, 'src/a.ts')).toBeUndefined()
    expect(findNode(after, 'docs')).toBe(docsBefore)
    expect(findNode(after, 'src/sub')).toBe(subBefore)
    // Pre-mutation tree untouched.
    expect(findNode(before, 'src/a.ts')).toBeDefined()
  })

  it('remove of a missing node is a full no-op: state object unchanged', () => {
    const before = tree()
    store.getState().removeFileNode('src/ghost.ts')
    expect(tree()).toBe(before)
    store.getState().removeFileNode('nope/deep/x.ts')
    expect(tree()).toBe(before)
  })
})

describe('setDirChildren structural sharing', () => {
  it('replaces the target dir children, keeps sibling subtrees', () => {
    const before = tree()
    const docsBefore = findNode(before, 'docs')!

    store.getState().setDirChildren('src', [
      { name: 'z.ts', path: 'src/z.ts', type: 'file' },
      { name: 'k', path: 'src/k', type: 'directory', hasChildren: false },
    ])

    const after = tree()
    expect(after).not.toBe(before)
    expect(findNode(after, 'src')).not.toBe(findNode(before, 'src'))
    // Dirs sort before files.
    expect(findNode(after, 'src')!.children!.map((c) => c.name)).toEqual(['k', 'z.ts'])
    expect(findNode(after, 'docs')).toBe(docsBefore)
  })

  it('first load of a never-loaded dir (the lazy-load path) fills children in place', () => {
    // FileTree's expand → loadDirChildren → setDirChildren on children === undefined.
    // The spine walk must ENTER the unloaded target (found via its parent's
    // children), not bail on it.
    const before = tree()
    store.getState().setDirChildren('lazy', [{ name: 'in.md', path: 'lazy/in.md', type: 'file' }])
    const after = tree()

    const lazyAfter = findNode(after, 'lazy')!
    expect(lazyAfter.children!.map((c) => c.name)).toEqual(['in.md'])
    expect(lazyAfter.hasChildren).toBe(true)
    expect(findNode(after, 'docs')).toBe(findNode(before, 'docs'))
    expect(findNode(after, 'src')).toBe(findNode(before, 'src'))
  })

  it('root-level replace ("") keeps nothing but works; unknown dir is a no-op', () => {
    store.getState().setDirChildren('', [{ name: 'only.md', path: 'only.md', type: 'file' }])
    expect(tree().children!.map((c) => c.name)).toEqual(['only.md'])

    const before = tree()
    store.getState().setDirChildren('ghost', [])
    expect(tree()).toBe(before)
  })
})
