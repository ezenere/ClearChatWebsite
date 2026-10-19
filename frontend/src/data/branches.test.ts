// Fixture compartilhado (docs/test-vectors/branches.json): o site precisa calcular a mesma mãe
// efetiva, o mesmo caminho ativo e os mesmos irmãos que o app.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { activePath, buildTree, siblingInfo, toBranchSel, type BranchNode } from './branches'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/test-vectors')

interface Case {
  name: string
  messages: BranchNode[]
  branchSel: Record<string, string | null>
  parents: Record<string, string | null>
  path: string[]
  siblings: Record<string, { index: number; count: number }>
}
const fixture = JSON.parse(readFileSync(join(DIR, 'branches.json'), 'utf8')) as { cases: Case[] }

describe('branches.json (árvore de versões, §4.3.8)', () => {
  it('tem os casos esperados', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(18)
  })
  for (const c of fixture.cases) {
    it(c.name, () => {
      const tree = buildTree(c.messages, (m) => m)
      expect(Object.fromEntries(tree.parentOf)).toEqual(c.parents)
      expect(activePath(tree, c.branchSel).map((m) => m.id)).toEqual(c.path)
      const sib = Object.fromEntries(
        c.messages.map((m) => {
          const s = siblingInfo(tree, m.id)!
          return [m.id, { index: s.index, count: s.count }]
        })
      )
      expect(sib).toEqual(c.siblings)
    })
  }
})

describe('siblingInfo / toBranchSel', () => {
  const msgs: BranchNode[] = [
    { id: 'u1', seq: 1, parentId: null },
    { id: 'a1', seq: 2, parentId: 'u1' },
    { id: 'a1b', seq: 3, parentId: 'u1' },
    { id: 'a1c', seq: 4, parentId: 'u1' }
  ]
  it('vizinhos e chave da bifurcação', () => {
    const tree = buildTree(msgs, (m) => m)
    expect(siblingInfo(tree, 'a1b')).toEqual({
      index: 1,
      count: 3,
      parentKey: 'u1',
      prevId: 'a1',
      nextId: 'a1c'
    })
    expect(siblingInfo(tree, 'u1')).toMatchObject({ parentKey: 'root', prevId: null, nextId: null })
    expect(siblingInfo(tree, 'nao-existe')).toBeNull()
  })
  it('branchSel malformado vira {} e valores inválidos são descartados', () => {
    expect(toBranchSel(undefined)).toEqual({})
    expect(toBranchSel([1])).toEqual({})
    expect(toBranchSel('x')).toEqual({})
    expect(toBranchSel({ a: 'b', root: null, c: 3, d: { x: 1 } })).toEqual({ a: 'b', root: null })
  })
})
