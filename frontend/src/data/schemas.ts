// Esquemas do plaintext dos registros (SYNC_PROTOCOL.md §4.3) — só os campos que o site lê/edita.
// Leitores ignoram campos desconhecidos e os PRESERVAM ao regravar (merge por campo).

export type ProviderKind = 'openai' | 'openrouter' | 'anthropic'

export const PROVIDER_KINDS: ProviderKind[] = ['openai', 'openrouter', 'anthropic']
export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible (genérico)',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (API nativa)'
}
export const PROVIDER_KIND_DEFAULT_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1'
}

export function inferProviderKind(baseUrl: string): ProviderKind {
  const u = (baseUrl ?? '').toLowerCase()
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  return 'openai'
}

export interface ProviderPlain {
  sv: 1
  name: string
  kind?: ProviderKind
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  createdAt: number
  [k: string]: unknown
}

export interface SettingPlain<T = unknown> {
  sv: 1
  value: T | null
  [k: string]: unknown
}

/** `setting webSearchApiKeys` (§4.3.2). */
export type ApiEngineId = 'brave-api' | 'exa' | 'tavily'
export type WebSearchApiKeys = Partial<Record<ApiEngineId, string>>
export const API_ENGINES: { id: ApiEngineId; label: string; site: string; hint: string }[] = [
  {
    id: 'brave-api',
    label: 'Brave Search API',
    site: 'https://brave.com/search/api/',
    hint: 'BSA…'
  },
  { id: 'exa', label: 'Exa', site: 'https://exa.ai/', hint: 'exa_…' },
  { id: 'tavily', label: 'Tavily', site: 'https://tavily.com/', hint: 'tvly-…' }
]

export interface ChatPlain {
  sv: 1
  title: string
  config: Record<string, unknown>
  mainSessionId: string
  createdAt: number
  updatedAt: number
  hostCwd?: { deviceId: string; path: string } | null
  [k: string]: unknown
}

export interface SessionPlain {
  sv: 1
  chatId: string
  parentSessionId: string | null
  parentToolCallId: string | null
  depth: number
  model: string
  providerId: string | null
  title: string
  task: string | null
  status: string
  createdAt: number
  /** Desde 1.2.0 (§4.3.7): versão escolhida em cada bifurcação; ausente = `{}`. */
  branchSel?: Record<string, string | null>
  [k: string]: unknown
}

export type ContentPart =
  | { type: 'text'; text: string; _attachment?: { name?: string }; _skill?: { name?: string } }
  | { type: 'image_url'; image_url: { url: string }; _attachment?: { name?: string } }
  | { type: 'file'; file?: { filename?: string }; _attachment?: { name?: string } }
  | { type: 'input_audio'; _attachment?: { name?: string } }
  | { type: string; [k: string]: unknown }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ApiMessage =
  | { role: 'system'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: string | ContentPart[] }

export interface MessageMeta {
  synthetic?: boolean
  kind?: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number; cost?: number }
  [k: string]: unknown
}

export interface MessagePlain {
  sv: 1
  sessionId: string
  seq: number
  message: ApiMessage
  meta: MessageMeta
  createdAt: number
  /** Desde 1.2.0 (§4.3.8): mensagem anterior no mesmo ramo; `null` = raiz; ausente = derivada. */
  parentId?: string | null
  [k: string]: unknown
}
