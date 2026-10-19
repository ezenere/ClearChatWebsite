import { describe, expect, it } from 'vitest'
import {
  ARGON2_DEFAULT,
  AuthError,
  createKeyMaterial,
  deriveSubkeys,
  fromB64u,
  hex,
  isWellFormedEnvelope,
  keyProof,
  normalizeRecoveryInput,
  openRecord,
  passwordChangeBody,
  type PasswordKekFn,
  passwordKek,
  RecoveryKeyError,
  recoveryChangeBody,
  sealRecord,
  sha256,
  b64u,
  unlockWithPassword,
  unlockWithRecovery,
  type KeysResponse
} from '.'

const USER = '6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b'
// Argon2id com parâmetros mínimos aceitos (rápido nos testes; o padrão de produção é coberto nos vetores)
const FAST = { ...ARGON2_DEFAULT, m: 19456, t: 2 }
const kek: PasswordKekFn = (pw, salt, kdf) => passwordKek(pw, salt, kdf)

const asKeys = (body: Awaited<ReturnType<typeof createKeyMaterial>>['body']): KeysResponse => ({
  key_version: 1,
  keys_rev: 1,
  password: body.password,
  recovery: body.recovery
})

describe('cadastro → desbloqueio → recuperação → troca de senha', () => {
  it('fluxo completo', async () => {
    const { dek, recoveryKey, body } = await createKeyMaterial(USER, 'senha forte 123', FAST, kek)
    expect(dek.length).toBe(32)
    expect(recoveryKey).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(fromB64u(body.password.salt).length).toBe(16)
    expect(fromB64u(body.recovery.salt).length).toBe(16)
    expect(fromB64u(body.password.wrap.n).length).toBe(12)
    expect(fromB64u(body.password.wrap.c).length).toBe(48)
    expect(body.recovery.kdf).toEqual({ alg: 'hkdf-sha256' })
    expect(body.password.kdf).toEqual(FAST)
    // verifier = SHA-256(K_verify)
    const sk = await deriveSubkeys(dek)
    expect(body.verifier).toBe(b64u(await sha256(sk.keyVerify)))

    const keys = asKeys(body)
    expect(hex(await unlockWithPassword(USER, keys, 'senha forte 123', kek))).toBe(hex(dek))
    await expect(unlockWithPassword(USER, keys, 'senha errada!!', kek)).rejects.toBeInstanceOf(
      AuthError
    )
    // a wrap é amarrada ao usuário
    await expect(
      unlockWithPassword('00000000-0000-4000-8000-000000000000', keys, 'senha forte 123', kek)
    ).rejects.toBeInstanceOf(AuthError)

    // recuperação aceita digitação "bagunçada"
    const messy = recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')
    expect(hex(await unlockWithRecovery(USER, keys, messy))).toBe(hex(dek))
    const typo =
      recoveryKey.slice(0, 5) + (recoveryKey[5] === 'A' ? 'B' : 'A') + recoveryKey.slice(6)
    await expect(unlockWithRecovery(USER, keys, typo)).rejects.toBeInstanceOf(RecoveryKeyError)

    // troca de senha: mesma DEK, key_proof confere com o verifier
    const change = await passwordChangeBody(USER, dek, 'outra senha 456', FAST, kek)
    expect(b64u(await sha256(fromB64u(change.key_proof)))).toBe(body.verifier)
    expect(change.password.salt).not.toBe(body.password.salt)
    const keys2 = { ...keys, password: change.password, keys_rev: 2 }
    expect(hex(await unlockWithPassword(USER, keys2, 'outra senha 456', kek))).toBe(hex(dek))
    await expect(unlockWithPassword(USER, keys2, 'senha forte 123', kek)).rejects.toThrow()

    // nova chave de recuperação: a antiga deixa de funcionar
    const rec = await recoveryChangeBody(USER, dek)
    expect(rec.recoveryKey).not.toBe(recoveryKey)
    expect(rec.body.key_proof).toBe((await keyProof(sk)).key_proof)
    const keys3 = { ...keys2, recovery: rec.body.recovery }
    expect(hex(await unlockWithRecovery(USER, keys3, rec.recoveryKey))).toBe(hex(dek))
    await expect(unlockWithRecovery(USER, keys3, recoveryKey)).rejects.toBeInstanceOf(AuthError)
  })

  it('servidor malicioso com kdf fraco é recusado antes do Argon2id', async () => {
    const { body } = await createKeyMaterial(USER, 'senha forte 123', FAST, kek)
    const keys = asKeys(body)
    keys.password.kdf = { ...FAST, m: 1024, t: 1 }
    await expect(unlockWithPassword(USER, keys, 'senha forte 123')).rejects.toThrow(/limites/)
  })

  it('normaliza a digitação da chave', () => {
    expect(normalizeRecoveryInput(' ab-cd il o ')).toBe('ABCD110')
  })
})

describe('envelope de registro', () => {
  it('roundtrip cru e comprimido, AAD amarrada', async () => {
    const sk = await deriveSubkeys(new Uint8Array(32).fill(7))
    const ref = { type: 'provider', id: 'p1', scope: null, rev: 3 }
    const small = { sv: 1, name: 'X', apiKey: 'sk-1', extra: { keep: true } }
    const env = await sealRecord(sk.record, USER, ref, small)
    expect(isWellFormedEnvelope(env)).toBe(true)
    expect(await openRecord(sk.record, USER, ref, env)).toEqual(small)
    await expect(openRecord(sk.record, USER, { ...ref, rev: 4 }, env)).rejects.toBeInstanceOf(
      AuthError
    )
    await expect(
      openRecord(sk.record, USER, { ...ref, type: 'preset' }, env)
    ).rejects.toBeInstanceOf(AuthError)

    const big = { sv: 1, content: 'abc '.repeat(1000) }
    const env2 = await sealRecord(sk.record, USER, ref, big)
    // comprimido: ciphertext bem menor que o JSON
    expect(fromB64u(env2.c).length).toBeLessThan(JSON.stringify(big).length / 4)
    expect(await openRecord(sk.record, USER, ref, env2)).toEqual(big)
  })

  it('formato inválido', () => {
    expect(isWellFormedEnvelope({ v: 2, k: 1, n: 'AAAAAAAAAAAAAAAA', c: 'A'.repeat(24) })).toBe(
      false
    )
    expect(isWellFormedEnvelope({ v: 1, k: 1, n: 'AAAA', c: 'A'.repeat(24) })).toBe(false)
    expect(isWellFormedEnvelope({ v: 1, k: 1, n: 'AAAAAAAAAAAAAAAA', c: 'AAAA' })).toBe(false)
    expect(isWellFormedEnvelope({ v: 1, k: 1, n: 'AAAAAAAAAAAAAAAA', c: 'A'.repeat(24) })).toBe(
      true
    )
  })
})
