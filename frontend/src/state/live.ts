// Notificações de mudança de registros vindas do WebSocket (`sync.changes`) → as telas recarregam.
import { useEffect, useRef } from 'react'
import type { Change } from '../api/types'

/** `null` = "recarregue tudo" (reconexão: eventos perdidos enquanto o socket estava fora, §10.2). */
type Listener = (changes: Change[] | null) => void
const listeners = new Set<Listener>()

export function emitChanges(changes: Change[]): void {
  for (const l of listeners) l(changes)
}

export function emitResync(): void {
  for (const l of listeners) l(null)
}

export function onChanges(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Chama `refetch` (com debounce) quando chegar mudança de algum dos tipos — ou, com `scope`, só de
 * registros daquele escopo (ou do próprio chat).
 */
export function useLiveRefresh(
  types: string[],
  refetch: () => void,
  opts: { scope?: string; delayMs?: number } = {}
): void {
  const ref = useRef(refetch)
  useEffect(() => {
    ref.current = refetch
  })
  const key = types.join(',')
  const { scope, delayMs = 250 } = opts
  useEffect(() => {
    const wanted = new Set(key.split(','))
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onChanges((changes) => {
      const hit =
        changes === null ||
        changes.some((c) => wanted.has(c.type) && (!scope || c.scope === scope || c.id === scope))
      if (!hit) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ref.current(), delayMs)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [key, scope, delayMs])
}
