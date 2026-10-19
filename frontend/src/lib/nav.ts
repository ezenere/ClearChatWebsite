const ORIGIN = 'https://clearchat.invalid'

/**
 * `next` só aceita caminhos internos do site (evita redirecionamento aberto). Recusa também caracteres de
 * controle/espaços (o parser de URL descarta TAB/LF, então "/\t/host" vira "//host") e qualquer coisa que
 * um parser de URL leia como outra origem (protocol-relative, barra invertida etc.).
 */
export function safeNext(next: string | null, fallback = '/app'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\s]/.test(next)) return fallback
  try {
    if (new URL(next, ORIGIN).origin !== ORIGIN) return fallback
  } catch {
    return fallback
  }
  return next
}
