// KEK da senha num Web Worker (cai para a thread principal se o worker não subir).
import { type Bytes, passwordKek, type PasswordKekFn } from '../crypto'

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (k: Bytes) => void; reject: (e: Error) => void }>()

function getWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('../workers/argon2.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<{ id: number; kek?: Uint8Array; error?: string }>) => {
      const p = pending.get(ev.data.id)
      if (!p) return
      pending.delete(ev.data.id)
      if (ev.data.kek) p.resolve(new Uint8Array(ev.data.kek))
      else p.reject(new Error(ev.data.error ?? 'falha no Argon2id'))
    }
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('worker falhou'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
    return worker
  } catch {
    return null
  }
}

export const kekInWorker: PasswordKekFn = async (password, salt, kdf) => {
  const w = getWorker()
  if (!w) return passwordKek(password, salt, kdf)
  try {
    return await new Promise<Bytes>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      w.postMessage({ id, password, salt: new Uint8Array(salt), kdf })
    })
  } catch (e) {
    // erro de validação dos parâmetros vem do próprio passwordKek: propaga; falha do worker: tenta aqui
    if (e instanceof Error && /kdf|limites|salt/.test(e.message)) throw e
    return passwordKek(password, salt, kdf)
  }
}
