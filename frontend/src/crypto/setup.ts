// Operações de chave de alto nível (cadastro, desbloqueio, troca de senha, nova chave de recuperação)
// sobre as primitivas do protocolo (SYNC_PROTOCOL.md §3.4–3.8, §5.1, §5.5, §6.5).
import { ARGON2_DEFAULT, type KdfParams } from './constants'
import { b64u, type Bytes, fromB64u } from './encoding'
import { formatRecoveryKey, parseRecoveryKey, passwordKek, recoveryKek } from './kdf'
import { aadWrap, deriveSubkeys, keyProof, unwrapDek, type Wrap, wrapDek } from './keys'
import { randomBytes } from './primitives'

/** Função que calcula a KEK da senha (permite rodar o Argon2id num Web Worker). */
export type PasswordKekFn = (password: string, salt: Uint8Array, kdf: KdfParams) => Promise<Bytes>

export interface PasswordSlot {
  kdf: KdfParams
  salt: string
  wrap: Wrap
}
export interface RecoverySlot {
  kdf: { alg: 'hkdf-sha256' }
  salt: string
  wrap: Wrap
}
export interface KeysResponse {
  key_version: number
  keys_rev: number
  password: PasswordSlot
  recovery: RecoverySlot
}
export interface KeysSetupBody {
  password: PasswordSlot
  recovery: RecoverySlot
  verifier: string
}

const defaultKek: PasswordKekFn = (pw, salt, kdf) => passwordKek(pw, salt, kdf)

export async function makePasswordSlot(
  userId: string,
  dek: Uint8Array,
  password: string,
  kdf: KdfParams = ARGON2_DEFAULT,
  kekFn: PasswordKekFn = defaultKek
): Promise<PasswordSlot> {
  const salt = randomBytes(16)
  const kek = await kekFn(password, salt, kdf)
  try {
    return { kdf, salt: b64u(salt), wrap: await wrapDek(kek, dek, aadWrap(userId, 'password')) }
  } finally {
    kek.fill(0)
  }
}

export async function makeRecoverySlot(
  userId: string,
  dek: Uint8Array
): Promise<{ slot: RecoverySlot; recoveryKey: string }> {
  const entropy = randomBytes(20)
  const salt = randomBytes(16)
  let kek: Bytes | null = null
  try {
    kek = await recoveryKek(entropy, salt)
    return {
      slot: {
        kdf: { alg: 'hkdf-sha256' },
        salt: b64u(salt),
        wrap: await wrapDek(kek, dek, aadWrap(userId, 'recovery'))
      },
      recoveryKey: await formatRecoveryKey(entropy)
    }
  } finally {
    // a chave em texto só sai na string formatada (mostrada uma vez); os bytes não ficam na memória
    kek?.fill(0)
    entropy.fill(0)
  }
}

/** Cadastro: DEK nova (32 bytes), wraps (senha e recuperação), verifier e a chave de recuperação. */
export async function createKeyMaterial(
  userId: string,
  password: string,
  kdf: KdfParams = ARGON2_DEFAULT,
  kekFn: PasswordKekFn = defaultKek
): Promise<{ dek: Bytes; recoveryKey: string; body: KeysSetupBody }> {
  const dek = randomBytes(32)
  const [password_, rec, sk] = await Promise.all([
    makePasswordSlot(userId, dek, password, kdf, kekFn),
    makeRecoverySlot(userId, dek),
    deriveSubkeys(dek)
  ])
  const { verifier } = await keyProof(sk)
  return {
    dek,
    recoveryKey: rec.recoveryKey,
    body: { password: password_, recovery: rec.slot, verifier }
  }
}

/** Senha → DEK. Senha errada → AuthError (falha do GCM; não existe outro verificador). */
export async function unlockWithPassword(
  userId: string,
  keys: KeysResponse,
  password: string,
  kekFn: PasswordKekFn = defaultKek
): Promise<Bytes> {
  const salt = fromB64u(keys.password.salt)
  if (salt.length !== 16) throw new Error('salt inválido')
  const kek = await kekFn(password, salt, keys.password.kdf)
  try {
    return await unwrapDek(kek, keys.password.wrap, aadWrap(userId, 'password', keys.key_version))
  } finally {
    kek.fill(0)
  }
}

/** Chave de recuperação → DEK. Checksum errado → RecoveryKeyError antes de qualquer cálculo. */
export async function unlockWithRecovery(
  userId: string,
  keys: KeysResponse,
  recoveryInput: string
): Promise<Bytes> {
  const entropy = await parseRecoveryKey(recoveryInput)
  let kek: Bytes | null = null
  try {
    if (keys.recovery.kdf?.alg !== 'hkdf-sha256')
      throw new Error('kdf de recuperação não suportado')
    kek = await recoveryKek(entropy, fromB64u(keys.recovery.salt))
    return await unwrapDek(kek, keys.recovery.wrap, aadWrap(userId, 'recovery', keys.key_version))
  } finally {
    kek?.fill(0)
    entropy.fill(0)
  }
}

/** Corpo de `PUT /keys/password`: salt novo, Argon2id da senha nova, nova wrap da MESMA DEK. */
export async function passwordChangeBody(
  userId: string,
  dek: Uint8Array,
  newPassword: string,
  kdf: KdfParams = ARGON2_DEFAULT,
  kekFn: PasswordKekFn = defaultKek
): Promise<{ key_proof: string; password: PasswordSlot }> {
  const [password, sk] = await Promise.all([
    makePasswordSlot(userId, dek, newPassword, kdf, kekFn),
    deriveSubkeys(dek)
  ])
  return { key_proof: (await keyProof(sk)).key_proof, password }
}

/** Corpo de `PUT /keys/recovery` + a chave nova (mostrar uma vez). */
export async function recoveryChangeBody(
  userId: string,
  dek: Uint8Array
): Promise<{ recoveryKey: string; body: { key_proof: string; recovery: RecoverySlot } }> {
  const [rec, sk] = await Promise.all([makeRecoverySlot(userId, dek), deriveSubkeys(dek)])
  return {
    recoveryKey: rec.recoveryKey,
    body: { key_proof: (await keyProof(sk)).key_proof, recovery: rec.slot }
  }
}
