// Envelope e moldura do plaintext (SYNC_PROTOCOL.md §3.9) + atalhos para registros (§4).
import {
  COMPRESS_THRESHOLD,
  ENVELOPE_VERSION,
  FRAME_DEFLATE,
  FRAME_RAW,
  KEY_VERSION
} from './constants'
import { b64u, type Bytes, concat, fromB64u, fromUtf8, utf8 } from './encoding'
import { aadRecord } from './keys'
import { deflateRaw, gcmDecrypt, gcmEncrypt, inflateRaw, randomBytes } from './primitives'

export interface Envelope {
  v: number
  k: number
  n: string
  c: string
}

/** Moldura: 1 byte de formato + payload (JSON UTF-8 cru ou deflate-raw do JSON). */
export async function frameJson(json: string, compress: boolean): Promise<Bytes> {
  const body = utf8(json)
  return compress
    ? concat(new Uint8Array([FRAME_DEFLATE]), await deflateRaw(body))
    : concat(new Uint8Array([FRAME_RAW]), body)
}

export async function unframeJson(frame: Uint8Array): Promise<Record<string, unknown>> {
  if (frame.length < 1) throw new Error('moldura vazia')
  const body = frame.subarray(1)
  let raw: Uint8Array
  if (frame[0] === FRAME_RAW) raw = body
  else if (frame[0] === FRAME_DEFLATE) raw = await inflateRaw(body)
  else throw new Error(`formato de moldura desconhecido: ${frame[0]}`)
  const obj: unknown = JSON.parse(fromUtf8(raw))
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('payload não é objeto JSON')
  return obj as Record<string, unknown>
}

export async function seal(
  key: Uint8Array,
  aad: Uint8Array,
  frame: Uint8Array,
  nonce: Uint8Array = randomBytes(12)
): Promise<Envelope> {
  return {
    v: ENVELOPE_VERSION,
    k: KEY_VERSION,
    n: b64u(nonce),
    c: b64u(await gcmEncrypt(key, nonce, aad, frame))
  }
}

export class UnsupportedEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedEnvelopeError'
  }
}

/** Decifra e devolve a moldura. `v`/`k` desconhecidos → UnsupportedEnvelopeError (pedir atualização). */
export async function open(key: Uint8Array, aad: Uint8Array, env: Envelope): Promise<Bytes> {
  if (env.v !== ENVELOPE_VERSION)
    throw new UnsupportedEnvelopeError('versão de envelope não suportada')
  if (env.k !== KEY_VERSION) throw new UnsupportedEnvelopeError('versão de chave desconhecida')
  const n = fromB64u(env.n)
  if (n.length !== 12) throw new Error('nonce inválido')
  return gcmDecrypt(key, n, aad, fromB64u(env.c))
}

/** Validação de formato (a mesma que o servidor faz, sem decifrar). */
export function isWellFormedEnvelope(env: unknown): env is Envelope {
  if (!env || typeof env !== 'object') return false
  const e = env as Record<string, unknown>
  if (e.v !== 1 || typeof e.k !== 'number' || e.k < 1) return false
  if (typeof e.n !== 'string' || typeof e.c !== 'string') return false
  try {
    return fromB64u(e.n).length === 12 && fromB64u(e.c).length >= 17
  } catch {
    return false
  }
}

// ---------------- Registros ----------------

export interface RecordRef {
  type: string
  id: string
  scope: string | null
  rev: number
}

/** Cifra o plaintext de um registro (comprime acima de 1 KiB). */
export async function sealRecord(
  recordKey: Uint8Array,
  userId: string,
  ref: RecordRef,
  plaintext: Record<string, unknown>,
  nonce?: Uint8Array
): Promise<Envelope> {
  const json = JSON.stringify(plaintext)
  const frame = await frameJson(json, utf8(json).length > COMPRESS_THRESHOLD)
  return seal(recordKey, aadRecord(userId, ref.type, ref.id, ref.scope, ref.rev), frame, nonce)
}

/** Decifra um registro com a AAD do próprio change (usuário + tipo + id + escopo + revisão). */
export async function openRecord(
  recordKey: Uint8Array,
  userId: string,
  ref: RecordRef,
  env: Envelope
): Promise<Record<string, unknown>> {
  const frame = await open(recordKey, aadRecord(userId, ref.type, ref.id, ref.scope, ref.rev), env)
  return unframeJson(frame)
}
