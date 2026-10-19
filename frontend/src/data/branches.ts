// Árvore de versões das mensagens de UMA sessão (SYNC_PROTOCOL.md §4.3.8, desde 1.2.0): mãe efetiva,
// filhos, caminho ativo e irmãos. Algoritmo normativo — o mesmo do app (src/shared/branches.ts) e de
// qualquer outro cliente; casos compartilhados em docs/test-vectors/branches.json.

/** `session.branchSel` (§4.3.7): chave = id da mãe ou `"root"`; valor = filho escolhido ou `null`. */
export type BranchSel = Record<string, string | null>

export const ROOT_KEY = 'root'

export interface BranchNode {
  id: string
  seq: number
  /** Ausente = registro de cliente < 0.7 (mãe derivada). */
  parentId?: string | null
}

export interface BranchTree<T> {
  /** Ordem da sessão: `seq` crescente, empate por `id` (comparação ASCII). */
  order: T[]
  /** Mãe efetiva de cada mensagem (`null` = raiz). */
  parentOf: Map<string, string | null>
  /** Filhos por chave (id da mãe ou `"root"`), na ordem da sessão; o mais novo é o último. */
  children: Map<string, T[]>
  node: (t: T) => BranchNode
}

export interface SiblingInfo {
  /** A partir de 0, na ordem da sessão. */
  index: number
  count: number
  /** Chave de `branchSel` da bifurcação (id da mãe efetiva ou `"root"`). */
  parentKey: string
  prevId: string | null
  nextId: string | null
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `branchSel` vindo do plaintext: só aceita objeto simples com valores string|null. */
export function toBranchSel(v: unknown): BranchSel {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: BranchSel = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (x === null || typeof x === 'string') out[k] = x
  return out
}

export function buildTree<T>(items: T[], node: (t: T) => BranchNode): BranchTree<T> {
  const order = [...items].sort((a, b) => {
    const x = node(a)
    const y = node(b)
    return x.seq - y.seq || cmpId(x.id, y.id)
  })
  const byId = new Map<string, BranchNode>()
  for (const t of order) byId.set(node(t).id, node(t))
  const parentOf = new Map<string, string | null>()
  const children = new Map<string, T[]>()
  // `prev` = a mensagem com o maior seq menor que o atual (empate: maior id) — a mãe derivada
  let prev: string | null = null
  let lastId: string | null = null
  let lastSeq = -Infinity
  for (const t of order) {
    const m = node(t)
    if (m.seq !== lastSeq) prev = lastId
    let parent: string | null
    const p = m.parentId
    if (p === null) parent = null
    else if (typeof p === 'string' && byId.has(p) && byId.get(p)!.seq < m.seq) parent = p
    else parent = prev // derivada só na leitura (nunca regravada)
    parentOf.set(m.id, parent)
    const key = parent ?? ROOT_KEY
    const list = children.get(key)
    if (list) list.push(t)
    else children.set(key, [t])
    lastId = m.id
    lastSeq = m.seq
  }
  return { order, parentOf, children, node }
}

/** Caminho ativo (§4.3.8): da raiz à folha, seguindo `branchSel` ou o filho mais novo. */
export function activePath<T>(tree: BranchTree<T>, sel: BranchSel): T[] {
  const path: T[] = []
  let k = ROOT_KEY
  // seq cresce a cada passo, então o laço termina; o limite é só uma rede de segurança
  for (let guard = 0; guard <= tree.order.length; guard++) {
    const kids = tree.children.get(k)
    if (!kids?.length) break
    const has = Object.hasOwn(sel, k)
    if (has && sel[k] === null) break // o caminho termina em k
    const chosen = has ? kids.find((c) => tree.node(c).id === sel[k]) : undefined
    const m = chosen ?? kids[kids.length - 1]
    path.push(m)
    k = tree.node(m).id
  }
  return path
}

/** Irmãos de uma mensagem = filhos da mãe efetiva dela (ela inclusa). */
export function siblingInfo<T>(tree: BranchTree<T>, id: string): SiblingInfo | null {
  if (!tree.parentOf.has(id)) return null
  const parentKey = tree.parentOf.get(id) ?? ROOT_KEY
  const kids = tree.children.get(parentKey) ?? []
  const index = kids.findIndex((c) => tree.node(c).id === id)
  if (index < 0) return null
  return {
    index,
    count: kids.length,
    parentKey,
    prevId: index > 0 ? tree.node(kids[index - 1]).id : null,
    nextId: index < kids.length - 1 ? tree.node(kids[index + 1]).id : null
  }
}
