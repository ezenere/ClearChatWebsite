// Hierarquia de chaves, AADs e wraps da DEK (SYNC_PROTOCOL.md §3.3, §3.6–3.8, §3.10).
import { HKDF_INFO, KEY_VERSION } from './constants'
import { b64u, type Bytes, concat, fromB64u, utf8 } from './encoding'
import { gcmDecrypt, gcmEncrypt, hkdf, randomBytes, sha256 } from './primitives'

export interface Subkeys {
  record: Bytes
  blob: Bytes
  blobId: Bytes
  stream: Bytes
  recordId: Bytes
  keyVerify: Bytes
}

/** Subchaves derivadas da DEK (HKDF-SHA256, salt vazio). */
export async function deriveSubkeys(dek: Uint8Array): Promise<Subkeys> {
  if (dek.length !== 32) throw new Error('DEK precisa de 32 bytes')
  const empty = new Uint8Array(0)
  const [record, blob, blobId, stream, recordId, keyVerify] = await Promise.all([
    hkdf(dek, empty, HKDF_INFO.record),
    hkdf(dek, empty, HKDF_INFO.blob),
    hkdf(dek, empty, HKDF_INFO.blobId),
    hkdf(dek, empty, HKDF_INFO.stream),
    hkdf(dek, empty, HKDF_INFO.recordId),
    hkdf(dek, empty, HKDF_INFO.keyVerify)
  ])
  return { record, blob, blobId, stream, recordId, keyVerify }
}

/** key_proof (enviado ao servidor em operações de chave) e verifier (guardado no servidor). */
export async function keyProof(sk: Subkeys): Promise<{ key_proof: string; verifier: string }> {
  return { key_proof: b64u(sk.keyVerify), verifier: b64u(await sha256(sk.keyVerify)) }
}

// ---------------- AADs (bytes EXATOS: UTF-8 da string, campos separados por "|") ----------------

export type WrapSlot = 'password' | 'recovery'

export const aadWrap = (userId: string, slot: WrapSlot, keyVersion = KEY_VERSION): Bytes =>
  utf8(`clearchat|v1|dek-wrap|${userId}|${slot}|${keyVersion}`)

export const aadRecord = (
  userId: string,
  type: string,
  id: string,
  scope: string | null,
  rev: number
): Bytes => utf8(`clearchat|v1|record|${userId}|${type}|${id}|${scope ?? ''}|${rev}`)

export const aadStream = (userId: string, chatId: string, epoch: number, n: number): Bytes =>
  utf8(`clearchat|v1|stream|${userId}|${chatId}|${epoch}|${n}`)

export const aadCommand = (userId: string, chatId: string, cmdId: string): Bytes =>
  utf8(`clearchat|v1|command|${userId}|${chatId}|${cmdId}`)

export const aadCommandResult = (userId: string, chatId: string, cmdId: string): Bytes =>
  utf8(`clearchat|v1|command-result|${userId}|${chatId}|${cmdId}`)

export const aadBlob = (userId: string, blobId: string, header: Uint8Array): Bytes =>
  concat(utf8(`clearchat|v1|blob|${userId}|${blobId}|`), header)

// ---------------- Wrap da DEK ----------------

export interface Wrap {
  n: string
  c: string
}

export async function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array = randomBytes(12)
): Promise<Wrap> {
  return { n: b64u(nonce), c: b64u(await gcmEncrypt(kek, nonce, aad, dek)) }
}

/** Falha de autenticação GCM (AuthError) = senha / chave de recuperação incorreta. */
export async function unwrapDek(kek: Uint8Array, w: Wrap, aad: Uint8Array): Promise<Bytes> {
  const n = fromB64u(w.n)
  const c = fromB64u(w.c)
  if (n.length !== 12 || c.length !== 48) throw new Error('wrap com formato inválido')
  const dek = await gcmDecrypt(kek, n, aad, c)
  if (dek.length !== 32) throw new Error('DEK inválida')
  return dek
}
