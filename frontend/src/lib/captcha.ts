/** Nonce do handshake do app: 16+ caracteres base64url (cabe no `cData` do Turnstile, ≤ 255). */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,255}$/

/** URL de retorno do captcha do app: `<base>/captcha/done#token=…&nonce=…` (SYNC_PROTOCOL.md §15). */
export function captchaDoneUrl(base: string, token: string, nonce: string): string {
  return `${base}/captcha/done#token=${encodeURIComponent(token)}&nonce=${encodeURIComponent(nonce)}`
}
