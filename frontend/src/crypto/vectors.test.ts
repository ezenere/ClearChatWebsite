// Vetores do contrato (docs/test-vectors/*.json) — o módulo src/crypto precisa bater byte a byte.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  aadBlob,
  aadCommand,
  aadCommandResult,
  aadRecord,
  aadStream,
  aadWrap,
  AuthError,
  b64u,
  blobIdFromSha256,
  checkKdfParams,
  decryptBlob,
  deriveSubkeys,
  encryptBlob,
  type Envelope,
  formatRecoveryKey,
  frameJson,
  fromB64u,
  fromHex,
  fromUtf8,
  hex,
  hkdf,
  keyProof,
  open,
  parseRecoveryKey,
  passwordKek,
  recoveryKek,
  seal,
  sha256,
  skillRecordId,
  unframeJson,
  unwrapDek,
  utf8,
  wrapDek,
  type WrapSlot
} from '.'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/test-vectors')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'))

const kdf = load('kdf.json')
const recovery = load('recovery.json')
const keys = load('keys.json')
const records = load('records.json')
const blobs = load('blobs.json')
const realtime = load('realtime.json')
const ids = load('ids.json')

describe('kdf.json (Argon2id via hash-wasm)', () => {
  for (const c of kdf.cases) {
    const allowTest = c.kdf.m < kdf.bounds.mMin
    it(c.name, async () => {
      const kek = await passwordKek(c.password, fromB64u(c.salt), c.kdf, allowTest)
      expect(hex(kek)).toBe(c.kek_hex)
    })
  }

  it('NFD na entrada dá o mesmo resultado que NFC', async () => {
    const c = kdf.cases[0]
    const nfd = fromUtf8(fromHex(c.password_nfd_utf8_hex))
    expect(nfd).not.toBe(c.password)
    expect(hex(utf8(c.password.normalize('NFC')))).toBe(c.password_nfc_utf8_hex)
    const kek = await passwordKek(nfd, fromB64u(c.salt), c.kdf)
    expect(hex(kek)).toBe(c.kek_hex)
  })

  it('recusa parâmetros fora dos limites (anti-downgrade / anti-DoS)', () => {
    expect(() => checkKdfParams(kdf.cases[1].kdf)).toThrow()
    const ok = kdf.cases[0].kdf
    expect(() => checkKdfParams(ok)).not.toThrow()
    expect(() => checkKdfParams({ ...ok, m: kdf.bounds.mMax + 1 })).toThrow()
    expect(() => checkKdfParams({ ...ok, t: 1 })).toThrow()
    expect(() => checkKdfParams({ ...ok, p: 5 })).toThrow()
    expect(() => checkKdfParams({ ...ok, alg: 'argon2i' })).toThrow()
    expect(() => checkKdfParams({ ...ok, v: 16 })).toThrow()
    expect(() => checkKdfParams({ ...ok, len: 64 })).toThrow()
  })
})

describe('recovery.json', () => {
  it('formata a entropia', async () => {
    expect(await formatRecoveryKey(fromHex(recovery.entropy_hex))).toBe(recovery.formatted)
  })
  for (const s of recovery.parse_accepts) {
    it(`aceita "${s}"`, async () => {
      expect(hex(await parseRecoveryKey(s))).toBe(recovery.entropy_hex)
    })
  }
  for (const s of recovery.parse_rejects) {
    it(`recusa "${s}"`, async () => {
      await expect(parseRecoveryKey(s)).rejects.toThrow()
    })
  }
  it('KEK_rk = HKDF(entropia, salt_rk)', async () => {
    const kek = await recoveryKek(fromHex(recovery.entropy_hex), fromB64u(recovery.salt))
    expect(hex(kek)).toBe(recovery.kek_hex)
  })
})

describe('keys.json', () => {
  it('subchaves HKDF', async () => {
    const sk = await deriveSubkeys(fromHex(keys.dek_hex))
    const byInfo: Record<string, Uint8Array> = {
      'clearchat/v1/record': sk.record,
      'clearchat/v1/blob': sk.blob,
      'clearchat/v1/blob-id': sk.blobId,
      'clearchat/v1/stream': sk.stream,
      'clearchat/v1/record-id': sk.recordId,
      'clearchat/v1/key-verify': sk.keyVerify
    }
    for (const [info, want] of Object.entries(keys.subkeys)) expect(hex(byInfo[info])).toBe(want)
    // e o mesmo via hkdf direto (salt vazio)
    const rec = await hkdf(fromHex(keys.dek_hex), new Uint8Array(0), 'clearchat/v1/record')
    expect(hex(rec)).toBe(keys.subkeys['clearchat/v1/record'])
  })

  it('key_proof e verifier', async () => {
    const sk = await deriveSubkeys(fromHex(keys.dek_hex))
    const p = await keyProof(sk)
    expect(p.key_proof).toBe(keys.key_proof)
    expect(p.verifier).toBe(keys.verifier)
    expect(b64u(await sha256(fromB64u(p.key_proof)))).toBe(keys.verifier)
  })

  for (const w of keys.wraps) {
    it(`wrap ${w.slot}: cifra igual e decifra`, async () => {
      const aad = aadWrap(keys.user_id, w.slot as WrapSlot)
      expect(fromUtf8(aad)).toBe(w.aad_utf8)
      const wrap = await wrapDek(
        fromHex(w.kek_hex),
        fromHex(keys.dek_hex),
        aad,
        fromHex(w.nonce_hex)
      )
      expect(wrap).toEqual(w.wrap)
      expect(fromB64u(wrap.c).length).toBe(48)
      const dek = await unwrapDek(fromHex(w.kek_hex), w.wrap, aad)
      expect(hex(dek)).toBe(keys.dek_hex)
    })
    it(`wrap ${w.slot}: KEK errada ou slot trocado → AuthError`, async () => {
      const bad = fromHex(w.kek_hex)
      bad[0] ^= 1
      await expect(unwrapDek(bad, w.wrap, aadWrap(keys.user_id, w.slot))).rejects.toBeInstanceOf(
        AuthError
      )
      const other: WrapSlot = w.slot === 'password' ? 'recovery' : 'password'
      await expect(
        unwrapDek(fromHex(w.kek_hex), w.wrap, aadWrap(keys.user_id, other))
      ).rejects.toBeInstanceOf(AuthError)
    })
  }

  it('cadeia completa: senha → KEK → DEK (vetor de produção)', async () => {
    const c = kdf.cases[0]
    const kek = await passwordKek(c.password, fromB64u(c.salt), c.kdf)
    const dek = await unwrapDek(kek, keys.wraps[0].wrap, aadWrap(keys.user_id, 'password'))
    expect(hex(dek)).toBe(keys.dek_hex)
  })
})

describe('records.json', () => {
  const key = fromHex(records.record_key_hex)
  for (const c of records.cases) {
    it(`${c.name}: AAD, moldura e envelope`, async () => {
      const aad = aadRecord(records.user_id, c.type, c.id, c.scope, c.rev)
      expect(fromUtf8(aad)).toBe(c.aad_utf8)
      // cifragem: a partir de frame_hex (o deflate de outra biblioteca pode diferir)
      const env = await seal(key, aad, fromHex(c.frame_hex), fromHex(c.nonce_hex))
      expect(env).toEqual(c.envelope)
      expect(fromB64u(env.c).length).toBe(c.ciphertext_size)
      // decifragem: open == frame_hex e unframe == json
      const frame = await open(key, aad, c.envelope)
      expect(hex(frame)).toBe(c.frame_hex)
      expect(JSON.stringify(await unframeJson(frame))).toBe(c.json)
    })
    it(`${c.name}: moldura própria (deflate local) faz roundtrip`, async () => {
      const compress = c.frame_hex.startsWith('01')
      const frame = await frameJson(c.json, compress)
      expect(frame[0]).toBe(compress ? 1 : 0)
      if (!compress) expect(hex(frame)).toBe(c.frame_hex)
      expect(JSON.stringify(await unframeJson(frame))).toBe(c.json)
    })
  }
  for (const c of records.must_fail) {
    it(`DEVE falhar: ${c.name}`, async () => {
      await expect(open(key, utf8(c.aad_utf8), c.envelope as Envelope)).rejects.toThrow()
    })
  }
})

describe('blobs.json', () => {
  const sk = {
    blob: fromHex(blobs.blob_key_hex),
    blobId: fromHex(blobs.blob_id_key_hex)
  } as Parameters<typeof encryptBlob>[0]
  const pattern = (len: number): Uint8Array => {
    const b = new Uint8Array(len)
    for (let i = 0; i < len; i++) b[i] = (i * 7 + 3) % 256
    return b
  }
  for (const c of blobs.cases) {
    it(c.name, async () => {
      const pt = pattern(c.plaintext_len)
      const ptSha = await sha256(pt)
      expect(hex(ptSha)).toBe(c.plaintext_sha256_hex)
      expect(await blobIdFromSha256(sk, ptSha)).toBe(c.blob_id)
      const ct = await encryptBlob(
        sk,
        blobs.user_id,
        c.blob_id,
        pt,
        fromHex(c.salt_hex),
        c.chunk_log2
      )
      expect(ct.length).toBe(c.ciphertext_len)
      expect(hex(await sha256(ct))).toBe(c.ciphertext_sha256_hex)
      expect(hex(ct)).toBe(c.ciphertext_hex)
      expect(hex(await decryptBlob(sk, blobs.user_id, c.blob_id, ct))).toBe(hex(pt))
    })
  }
  it('truncar o último chunk ou trocar o id do blob falha', async () => {
    const c = blobs.cases[0]
    const ct = fromHex(c.ciphertext_hex)
    await expect(
      decryptBlob(sk, blobs.user_id, c.blob_id, ct.subarray(0, ct.length - 16 - 452))
    ).rejects.toThrow()
    await expect(decryptBlob(sk, blobs.user_id, '00'.repeat(32), ct)).rejects.toThrow()
    expect(fromUtf8(aadBlob('u', 'b', new Uint8Array(0)))).toBe('clearchat|v1|blob|u|b|')
  })
})

describe('realtime.json', () => {
  const key = fromHex(realtime.stream_key_hex)
  const aads: Record<string, string> = {}
  it('AADs de stream/comando/resultado', () => {
    const [s, c, r] = realtime.cases
    const user = realtime.user_id
    const chat = '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e'
    aads.stream = fromUtf8(aadStream(user, chat, 42, 17))
    aads.command = fromUtf8(aadCommand(user, chat, 'cmd-7f3a'))
    aads.result = fromUtf8(aadCommandResult(user, chat, 'cmd-7f3a'))
    expect(aads.stream).toBe(s.aad_utf8)
    expect(aads.command).toBe(c.aad_utf8)
    expect(aads.result).toBe(r.aad_utf8)
  })
  for (const c of realtime.cases) {
    it(c.name, async () => {
      const frame = await frameJson(c.json, false)
      expect(hex(frame)).toBe(c.frame_hex)
      const env = await seal(key, utf8(c.aad_utf8), frame, fromHex(c.nonce_hex))
      expect(env).toEqual(c.envelope)
      expect(JSON.stringify(await unframeJson(await open(key, utf8(c.aad_utf8), env)))).toBe(c.json)
    })
  }
})

describe('ids.json', () => {
  const sk = {
    recordId: fromHex(ids.record_id_key_hex),
    blobId: fromHex(keys.subkeys['clearchat/v1/blob-id'])
  } as Parameters<typeof skillRecordId>[0]
  for (const s of ids.skills) {
    it(`skill "${s.name}"`, async () => {
      expect(await skillRecordId(sk, s.name)).toBe(s.record_id)
    })
  }
  for (const b of ids.blobs) {
    it('blob_id de "hello\\n"', async () => {
      const sha = await sha256(utf8(b.plaintext_utf8))
      expect(hex(sha)).toBe(b.plaintext_sha256_hex)
      expect(await blobIdFromSha256(sk, sha)).toBe(b.blob_id)
    })
  }
})
