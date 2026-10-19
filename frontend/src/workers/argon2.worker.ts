// Argon2id fora da thread da UI (64 MiB, ~0,5 s no desktop). Só calcula a KEK: a DEK nunca passa aqui.
import { passwordKek, type KdfParams } from '../crypto'

interface Req {
  id: number
  password: string
  salt: Uint8Array
  kdf: KdfParams
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, password, salt, kdf } = ev.data
  try {
    const kek = await passwordKek(password, salt, kdf)
    ;(self as unknown as Worker).postMessage({ id, kek }, [kek.buffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({
      id,
      error: e instanceof Error ? e.message : String(e)
    })
  }
}
