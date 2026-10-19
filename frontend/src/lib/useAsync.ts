import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './errors'

/** Carrega dados assíncronos com recarga manual; ignora respostas de cargas antigas. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const gen = useRef(0)
  const fnRef = useRef(fn)
  useEffect(() => {
    fnRef.current = fn
  })
  const reload = useCallback(async (silent = false) => {
    const my = ++gen.current
    if (!silent) setLoading(true)
    try {
      const v = await fnRef.current()
      if (my === gen.current) {
        setData(v)
        setError(null)
      }
    } catch (e) {
      if (my === gen.current) setError(errorMessage(e))
    } finally {
      if (my === gen.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    // `loading` já começa true; a carga roda fora do corpo do efeito (sem setState síncrono)
    void Promise.resolve().then(() => reload(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}
