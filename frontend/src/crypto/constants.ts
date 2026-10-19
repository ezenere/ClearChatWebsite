// Constantes do protocolo (SYNC_PROTOCOL.md §3) — espelham docs/test-vectors/generate.ts.

export const PROTOCOL_VERSION = 1
export const ENVELOPE_VERSION = 1
export const KEY_VERSION = 1

export interface KdfParams {
  alg: string
  v: number
  m: number
  t: number
  p: number
  len: number
}

/** Parâmetros Argon2id padrão para novas wraps (m em KiB = 64 MiB). */
export const ARGON2_DEFAULT: KdfParams = { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 }
/** Limites aceitos ao LER parâmetros vindos do servidor (anti-DoS / anti-downgrade). */
export const ARGON2_BOUNDS = { mMin: 19456, mMax: 1048576, tMin: 2, tMax: 10, pMin: 1, pMax: 4 }

export const HKDF_INFO = {
  record: 'clearchat/v1/record',
  blob: 'clearchat/v1/blob',
  blobId: 'clearchat/v1/blob-id',
  stream: 'clearchat/v1/stream',
  recordId: 'clearchat/v1/record-id',
  keyVerify: 'clearchat/v1/key-verify',
  recoveryKek: 'clearchat/v1/recovery-kek',
  blobFile: 'clearchat/v1/blob-file'
} as const

export const FRAME_RAW = 0x00
export const FRAME_DEFLATE = 0x01
/** Escritores DEVERIAM comprimir quando o JSON passar de 1 KiB (§3.9). */
export const COMPRESS_THRESHOLD = 1024
/** Teto de descompressão (proteção contra "zip bomb" de um servidor malicioso). */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024

export const BLOB_MAGIC = 'CCB1'
export const BLOB_HEADER_LEN = 21
export const BLOB_CHUNK_LOG2_DEFAULT = 20
export const BLOB_CHUNK_LOG2_MIN = 10
export const BLOB_CHUNK_LOG2_MAX = 24

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
