// Primitivas via WebCrypto (crypto.subtle) + CompressionStream — equivalentes ao node:crypto/zlib da
// implementação de referência (docs/test-vectors/generate.ts).
import { MAX_INFLATED_BYTES } from './constants'
import { concat, type Bytes, utf8 } from './encoding'

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto indisponível (o site precisa de HTTPS ou localhost)')
  return s
}

/** Erro de autenticação (GCM): chave errada, AAD diferente ou dados adulterados. */
export class AuthError extends Error {
  constructor(message = 'falha de autenticação (chave incorreta ou dados adulterados)') {
    super(message)
    this.name = 'AuthError'
  }
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', data as BufferSource))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await subtle().importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await subtle().sign('HMAC', k, data as BufferSource))
}

/** HKDF-SHA256 (RFC 5869). `salt` vazio = HashLen zeros. */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  len = 32
): Promise<Bytes> {
  const k = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8(info) },
    k,
    len * 8
  )
  return new Uint8Array(bits)
}

/** AES-256-GCM, tag de 16 bytes anexada ao fim. */
export async function gcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Promise<Bytes> {
  if (key.length !== 32) throw new Error('chave AES-256 precisa de 32 bytes')
  if (nonce.length !== 12) throw new Error('nonce GCM precisa de 12 bytes')
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  const out = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: 128
    },
    k,
    plaintext as BufferSource
  )
  return new Uint8Array(out)
}

export async function gcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ctAndTag: Uint8Array
): Promise<Bytes> {
  if (key.length !== 32) throw new Error('chave AES-256 precisa de 32 bytes')
  if (nonce.length !== 12) throw new Error('nonce GCM precisa de 12 bytes')
  if (ctAndTag.length < 16) throw new Error('ciphertext curto demais')
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt'])
  try {
    const out = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128
      },
      k,
      ctAndTag as BufferSource
    )
    return new Uint8Array(out)
  } catch {
    throw new AuthError()
  }
}

async function pipe(
  data: Uint8Array,
  stream: GenerateTransformStream,
  cap: number
): Promise<Bytes> {
  const readable = new Blob([data as BlobPart]).stream().pipeThrough(stream)
  const reader = readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel()
      throw new Error('conteúdo descomprimido grande demais')
    }
    parts.push(value)
  }
  return concat(...parts)
}

type GenerateTransformStream = ReadableWritablePair<Uint8Array, Uint8Array>

/** DEFLATE cru (RFC 1951). */
export function deflateRaw(data: Uint8Array): Promise<Bytes> {
  return pipe(
    data,
    new CompressionStream('deflate-raw') as unknown as GenerateTransformStream,
    Infinity
  )
}

export function inflateRaw(data: Uint8Array, cap = MAX_INFLATED_BYTES): Promise<Bytes> {
  return pipe(
    data,
    new DecompressionStream('deflate-raw') as unknown as GenerateTransformStream,
    cap
  )
}
