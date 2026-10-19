// Acesso aos registros cifrados: lista (paginada por seq), decifra no navegador e grava com as regras
// de conflito do contrato (§7.4–7.5): LWW por campo (reaplica só o que mudou por cima do atual) e
// "exclusão vence".
import { ApiClient, isApiError } from '../api/client'
import type { Change, PushConflict, PushItem } from '../api/types'
import { openRecord, sealRecord, type Subkeys, UnsupportedEnvelopeError } from '../crypto'

export interface Entry<T> {
  change: Change
  plain: T
}
export interface BrokenEntry {
  change: Change
  error: string
}

/**
 * Contexto que o cliente pediu. A AAD do registro amarra tipo/id/escopo, mas é remontada a partir dos
 * rótulos que o próprio servidor devolve — então o registro também precisa bater com o pedido, senão o
 * servidor poderia servir um registro autêntico de outro chat/id no lugar do pedido (§3.10).
 * `id`/`scope` ausentes = não restringe.
 */
export interface RecordContext {
  type: string
  id?: string
  scope?: string | null
}

export class RecordContextError extends Error {
  constructor() {
    super('registro fora do contexto pedido')
    this.name = 'RecordContextError'
  }
}

export function matchesContext(c: Change, ctx: RecordContext): boolean {
  return (
    c.type === ctx.type &&
    (ctx.id === undefined || c.id === ctx.id) &&
    (ctx.scope === undefined || (c.scope ?? null) === ctx.scope)
  )
}

const PAGE = 500

export class Repo {
  readonly api: ApiClient
  readonly userId: string
  private readonly sk: Subkeys

  constructor(api: ApiClient, userId: string, sk: Subkeys) {
    this.api = api
    this.userId = userId
    this.sk = sk
  }

  /** Estado atual (sem tombstones), todas as páginas. */
  async listAll(q: { type?: string; scope?: string; payload?: boolean }): Promise<Change[]> {
    const out: Change[] = []
    let after = 0
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await this.api.records({ ...q, after, limit: PAGE })
      out.push(...page.records)
      if (!page.has_more || !page.records.length) break
      after = page.next
    }
    return out.filter((c) => !c.deleted)
  }

  /**
   * Busca o payload dos registros que vieram com `omitted: true`. O `/records/fetch` também corta a resposta
   * em ~8 MiB (§7.2): o que não coube volta `omitted: true` de novo e é pedido outra vez, até não sobrar
   * nenhum. O servidor sempre devolve ao menos o primeiro com payload; rodada sem progresso encerra (o que
   * faltar fica sem payload → broken).
   */
  async fillOmitted(changes: Change[]): Promise<Change[]> {
    const key = (c: { type: string; id: string }) => `${c.type}|${c.id}`
    let want = [
      ...new Map(
        changes.filter((c) => c.omitted || !c.env).map((c) => [key(c), { type: c.type, id: c.id }])
      ).values()
    ]
    if (!want.length) return changes
    const byKey = new Map<string, Change>()
    for (let round = 0; want.length && round < 10_000; round++) {
      const again: { type: string; id: string }[] = []
      let filled = 0
      for (let i = 0; i < want.length; i += 500) {
        const batch = want.slice(i, i + 500)
        const asked = new Set(batch.map(key))
        const { records } = await this.api.fetchRecords(batch)
        for (const r of records) {
          const k = key(r)
          if (!asked.has(k)) continue // não foi pedido nesta leva
          asked.delete(k)
          if (r.omitted && !r.env) {
            again.push({ type: r.type, id: r.id })
          } else {
            byKey.set(k, r)
            filled++
          }
        }
      }
      if (!filled) break
      want = again
    }
    // só substitui pelo registro do mesmo tipo/id/escopo; senão fica o original (sem payload → broken)
    return changes.map((c) => {
      const r = byKey.get(`${c.type}|${c.id}`)
      return r && matchesContext(r, { type: c.type, id: c.id, scope: c.scope ?? null }) ? r : c
    })
  }

  /** Decifra. Com `expected`, recusa (RecordContextError) registro de outro tipo/id/escopo. */
  async decrypt<T>(c: Change, expected?: RecordContext): Promise<T> {
    if (expected && !matchesContext(c, expected)) throw new RecordContextError()
    if (!c.env) throw new Error('registro sem conteúdo')
    return (await openRecord(this.sk.record, this.userId, c, c.env)) as T
  }

  /** Lista e decifra. Registros que não decifram vão para `broken` (sem derrubar a lista). */
  async listDecrypted<T>(
    type: string,
    scope?: string
  ): Promise<{ entries: Entry<T>[]; broken: BrokenEntry[] }> {
    const changes = await this.fillOmitted(await this.listAll({ type, scope }))
    const entries: Entry<T>[] = []
    const broken: BrokenEntry[] = []
    await Promise.all(
      changes.map(async (change) => {
        try {
          entries.push({ change, plain: await this.decrypt<T>(change, { type, scope }) })
        } catch (e) {
          broken.push({
            change,
            error:
              e instanceof UnsupportedEnvelopeError
                ? 'formato de uma versão mais nova do app — atualize o site'
                : e instanceof RecordContextError
                  ? 'registro fora do contexto pedido (ignorado)'
                  : 'não foi possível decifrar'
          })
        }
      })
    )
    entries.sort((a, b) => a.change.seq - b.change.seq)
    return { entries, broken }
  }

  private async pushItem(item: PushItem): Promise<Change> {
    const res = await this.api.push({ push_id: crypto.randomUUID(), items: [item] })
    const r = res.results[0]
    return {
      seq: r.seq,
      type: item.type,
      id: item.id,
      scope: item.scope,
      rev: r.rev,
      deleted: item.deleted,
      env: item.env,
      size: 0,
      blobs: item.blobs,
      device_id: '',
      updated_at: new Date().toISOString()
    }
  }

  /**
   * Grava um registro. `mutate` recebe o plaintext atual (ou null se novo) e devolve o novo — em
   * conflito (`rev_mismatch`) é chamado de novo sobre a versão do servidor, reaplicando só a edição.
   */
  async save<T extends Record<string, unknown>>(
    ref: { type: string; id: string; scope: string | null },
    base: Entry<T> | null,
    mutate: (current: T | null) => T
  ): Promise<Entry<T>> {
    let baseRev = base?.change.rev ?? 0
    let current: T | null = base?.plain ?? null
    for (let attempt = 0; attempt < 4; attempt++) {
      const plain = mutate(current)
      const rev = baseRev + 1
      const env = await sealRecord(this.sk.record, this.userId, { ...ref, rev }, plain)
      try {
        const change = await this.pushItem({
          ...ref,
          base_rev: baseRev,
          rev,
          deleted: false,
          env,
          blobs: []
        })
        return { change, plain }
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw e
        if (c.reason === 'gone' || c.current?.deleted)
          throw new Error('Este item foi apagado em outro dispositivo.', { cause: e })
        if (c.reason !== 'rev_mismatch' || !c.current) throw e
        // a versão "atual" do conflito precisa ser o MESMO registro; senão o plaintext de outro seria
        // re-selado sob ref.id
        if (!matchesContext(c.current, ref)) throw e
        baseRev = c.current.rev
        current = await this.decrypt<T>(await this.ensurePayload(c.current), ref)
      }
    }
    throw new Error('Não foi possível salvar: o item mudou várias vezes seguidas. Tente de novo.')
  }

  /** Apaga (tombstone). A exclusão vence edições concorrentes; já apagado = sucesso. */
  async remove(change: Change): Promise<void> {
    let baseRev = change.rev
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.pushItem({
          type: change.type,
          id: change.id,
          scope: change.scope,
          base_rev: baseRev,
          rev: baseRev + 1,
          deleted: true,
          blobs: []
        })
        return
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw e
        if (c.reason === 'gone' || c.current?.deleted) return
        if (c.reason !== 'rev_mismatch' || !c.current) throw e
        baseRev = c.current.rev
      }
    }
    throw new Error('Não foi possível apagar. Tente de novo.')
  }

  private async ensurePayload(c: Change): Promise<Change> {
    return c.env ? c : (await this.fillOmitted([{ ...c, omitted: true }]))[0]
  }
}

function conflictOf(e: unknown): PushConflict | null {
  if (!isApiError(e, 'conflict')) return null
  const list = e.details.conflicts
  return Array.isArray(list) && list.length ? (list[0] as PushConflict) : null
}
