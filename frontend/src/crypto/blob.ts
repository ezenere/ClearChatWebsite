// Blobs CCB1 em chunks e ids derivados (SYNC_PROTOCOL.md §3.11–3.12).
import {
  BLOB_CHUNK_LOG2_DEFAULT,
  BLOB_CHUNK_LOG2_MAX,
  BLOB_CHUNK_LOG2_MIN,
  BLOB_HEADER_LEN,
  BLOB_MAGIC,
  HKDF_INFO
} from './constants'
import { type Bytes, concat, hex, utf8 } from './encoding'
import { aadBlob, type Subkeys } from './keys'
import { gcmDecrypt, gcmEncrypt, hkdf, hmacSha256 } from './primitives'

/** blob_id = hex(HMAC-SHA256(K_blob_id, SHA-256(plaintext))) — 64 hex minúsculos. */
export async function blobIdFromSha256(sk: Subkeys, plaintextSha256: Uint8Array): Promise<string> {
  return hex(await hmacSha256(sk.blobId, plaintextSha256))
}

/** id do registro `skill`: "sk_" + 32 hex de HMAC-SHA256(K_record_id, "skill|" + nome). */
export async function skillRecordId(sk: Subkeys, name: string): Promise<string> {
  return 'sk_' + hex(await hmacSha256(sk.recordId, utf8('skill|' + name))).slice(0, 32)
}

function chunkNonce(index: number, final: boolean): Bytes {
  const n = new Uint8Array(12)
  let v = index
  for (let i = 10; i >= 5; i--) {
    n[i] = v % 256
    v = Math.floor(v / 256)
  }
  n[11] = final ? 1 : 0
  return n
}

export async function encryptBlob(
  sk: Subkeys,
  userId: string,
  blobId: string,
  plaintext: Uint8Array,
  salt: Uint8Array,
  chunkLog2 = BLOB_CHUNK_LOG2_DEFAULT
): Promise<Bytes> {
  if (salt.length !== 16) throw new Error('salt do blob precisa de 16 bytes')
  if (chunkLog2 < BLOB_CHUNK_LOG2_MIN || chunkLog2 > BLOB_CHUNK_LOG2_MAX)
    throw new Error('chunk_log2 fora do intervalo')
  const header = concat(utf8(BLOB_MAGIC), new Uint8Array([chunkLog2]), salt)
  const fileKey = await hkdf(sk.blob, salt, HKDF_INFO.blobFile)
  const aad = aadBlob(userId, blobId, header)
  const cs = 2 ** chunkLog2
  const count = Math.max(1, Math.ceil(plaintext.length / cs))
  const parts: Uint8Array[] = [header]
  for (let i = 0; i < count; i++) {
    const chunk = plaintext.subarray(i * cs, Math.min(plaintext.length, (i + 1) * cs))
    parts.push(await gcmEncrypt(fileKey, chunkNonce(i, i === count - 1), aad, chunk))
  }
  return concat(...parts)
}

export async function decryptBlob(
  sk: Subkeys,
  userId: string,
  blobId: string,
  data: Uint8Array
): Promise<Bytes> {
  if (data.length < BLOB_HEADER_LEN + 16) throw new Error('blob curto demais')
  const header = data.subarray(0, BLOB_HEADER_LEN)
  if (String.fromCharCode(...header.subarray(0, 4)) !== BLOB_MAGIC)
    throw new Error('magic inválido')
  const chunkLog2 = header[4]
  if (chunkLog2 < BLOB_CHUNK_LOG2_MIN || chunkLog2 > BLOB_CHUNK_LOG2_MAX)
    throw new Error('chunk_log2 fora do intervalo')
  const salt = header.subarray(5, 21)
  const fileKey = await hkdf(sk.blob, salt, HKDF_INFO.blobFile)
  const aad = aadBlob(userId, blobId, header)
  const full = 2 ** chunkLog2 + 16
  const out: Uint8Array[] = []
  let off = BLOB_HEADER_LEN
  let i = 0
  for (;;) {
    const remaining = data.length - off
    const final = remaining <= full
    const len = final ? remaining : full
    if (len < 16) throw new Error('chunk truncado')
    out.push(await gcmDecrypt(fileKey, chunkNonce(i, final), aad, data.subarray(off, off + len)))
    off += len
    i++
    if (final) break
  }
  return concat(...out)
}
