// Codificações do protocolo (SYNC_PROTOCOL.md §3.2). Sem dependências: roda em navegador, Node e RN.

/** Bytes com buffer comum (não compartilhado) — o que o WebCrypto aceita como BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64U_REV: Record<string, number> = Object.fromEntries([...B64U].map((c, i) => [c, i]))

/** base64url sem padding (RFC 4648 §5). */
export function b64u(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64U[(v >>> 18) & 63] + B64U[(v >>> 12) & 63] + B64U[(v >>> 6) & 63] + B64U[v & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const v = bytes[i] << 16
    out += B64U[(v >>> 18) & 63] + B64U[(v >>> 12) & 63]
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64U[(v >>> 18) & 63] + B64U[(v >>> 12) & 63] + B64U[(v >>> 6) & 63]
  }
  return out
}

/** Decodifica base64url sem padding. Lança em caracteres fora do alfabeto ou comprimento impossível. */
export function fromB64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url inválido (sem padding, sem + /)')
  if (s.length % 4 === 1) throw new Error('base64url com comprimento inválido')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const ch of s) {
    acc = (acc << 6) | B64U_REV[ch]
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 255
    }
    acc &= (1 << bits) - 1
  }
  return out
}

export function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('hex inválido')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

const enc = new TextEncoder()
export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes
export const fromUtf8 = (b: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(b)

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Comparação em tempo constante (para o tamanho dado). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Cópia com buffer próprio (garante `Bytes` para o WebCrypto). */
export const own = (b: Uint8Array): Bytes => new Uint8Array(b)
