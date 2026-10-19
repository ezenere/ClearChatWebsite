// Configuração de tempo de execução: o container gera config.js com
// `window.__CLEARCHAT__ = { baseUrl: PUBLIC_BASE_URL }` (ARCHITECTURE.md §7). O caminho dessa URL é o
// caminho de base do site (basename do router, prefixo de /api e /ws, cookie Path).

declare global {
  interface Window {
    __CLEARCHAT__?: { baseUrl?: string }
  }
}

export const SITE_VERSION: string = import.meta.env.VITE_SITE_VERSION || '0.1.0'

/** Caminho de base sem "/" final ("" = raiz). Ex.: "/clearchat". */
export function basePath(): string {
  const raw = typeof window !== 'undefined' ? window.__CLEARCHAT__?.baseUrl : undefined
  if (!raw) return ''
  try {
    return new URL(raw).pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * Raiz das chamadas (mesma origem da página + caminho de base). Usar a origem atual (e não a URL
 * configurada) garante requisições same-origin: o cookie `cc_refresh` é SameSite=Strict e não há CORS.
 */
export function apiRoot(): string {
  return window.location.origin + basePath()
}

/** `<base>` como o app enxerga (para textos e para o handshake do captcha). */
export function publicBaseUrl(): string {
  return apiRoot()
}

export function wsUrl(): string {
  return apiRoot().replace(/^http/, 'ws') + '/ws'
}
