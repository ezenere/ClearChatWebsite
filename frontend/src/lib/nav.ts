/** `next` só aceita caminhos internos do site (evita redirecionamento aberto). */
export function safeNext(next: string | null, fallback = '/app'): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : fallback
}
