// Senha → KEK (Argon2id via hash-wasm 4.12.0) e chave de recuperação (SYNC_PROTOCOL.md §3.4–3.5).
import { argon2id } from 'hash-wasm'
import { ARGON2_BOUNDS, CROCKFORD, HKDF_INFO, type KdfParams } from './constants'
import { type Bytes, utf8 } from './encoding'
import { hkdf, sha256 } from './primitives'

/** Valida parâmetros vindos do servidor. `allowTest` só nos vetores de teste rápidos. */
export function checkKdfParams(k: KdfParams, allowTest = false): void {
  if (!k || k.alg !== 'argon2id' || k.v !== 19 || k.len !== 32) throw new Error('kdf não suportado')
  if (allowTest) return
  const b = ARGON2_BOUNDS
  const ints = [k.m, k.t, k.p].every((n) => Number.isInteger(n))
  if (
    !ints ||
    k.m < b.mMin ||
    k.m > b.mMax ||
    k.t < b.tMin ||
    k.t > b.tMax ||
    k.p < b.pMin ||
    k.p > b.pMax
  )
    throw new Error('parâmetros Argon2id fora dos limites aceitos')
}

/** KEK da senha: Argon2id(NFC(senha) em UTF-8, salt de 16 bytes) → 32 bytes. Sem trim. */
export async function passwordKek(
  password: string,
  salt: Uint8Array,
  k: KdfParams,
  allowTest = false
): Promise<Bytes> {
  checkKdfParams(k, allowTest)
  if (salt.length !== 16) throw new Error('salt precisa de 16 bytes')
  const out = await argon2id({
    password: utf8(password.normalize('NFC')),
    salt,
    parallelism: k.p,
    iterations: k.t,
    memorySize: k.m,
    hashLength: k.len,
    outputType: 'binary'
  })
  return new Uint8Array(out)
}

/** Base32 Crockford (MSB primeiro) — usado só na chave de recuperação. */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(s: string): Bytes {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch)
    if (v < 0) throw new RecoveryKeyError('caractere inválido na chave de recuperação')
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return new Uint8Array(out)
}

export class RecoveryKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryKeyError'
  }
}

/** 20 bits do SHA-256 da entropia → 4 caracteres base32. */
async function recoveryChecksum(entropy: Uint8Array): Promise<string> {
  const h = await sha256(entropy)
  const v = (h[0] << 12) | (h[1] << 4) | (h[2] >>> 4)
  let out = ''
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(v >>> (i * 5)) & 31]
  return out
}

/** 20 bytes de entropia → "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-CCCC". */
export async function formatRecoveryKey(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== 20) throw new Error('a chave de recuperação tem 20 bytes de entropia')
  const s = base32Encode(entropy) + (await recoveryChecksum(entropy))
  return s.match(/.{4}/g)!.join('-')
}

/** Normaliza a digitação: maiúsculas, sem espaços/hífens, O→0, I→1, L→1. */
export const normalizeRecoveryInput = (input: string): string =>
  input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

/** Aceita minúsculas, espaços/hífens em qualquer lugar e O→0, I→1, L→1. Lança se inválida. */
export async function parseRecoveryKey(input: string): Promise<Bytes> {
  const s = normalizeRecoveryInput(input)
  if (s.length !== 36)
    throw new RecoveryKeyError('a chave de recuperação tem 36 caracteres (9 grupos de 4)')
  const entropy = base32Decode(s.slice(0, 32))
  if (entropy.length !== 20) throw new RecoveryKeyError('chave de recuperação inválida')
  if ((await recoveryChecksum(entropy)) !== s.slice(32))
    throw new RecoveryKeyError('chave de recuperação incorreta (checksum)')
  return entropy
}

/** KEK da chave de recuperação: HKDF-SHA256(entropia, salt de 16 bytes guardado no servidor). */
export function recoveryKek(entropy: Uint8Array, salt: Uint8Array): Promise<Bytes> {
  if (salt.length !== 16) throw new Error('salt precisa de 16 bytes')
  return hkdf(entropy, salt, HKDF_INFO.recoveryKek)
}
