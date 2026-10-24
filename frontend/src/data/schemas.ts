// Esquemas do plaintext dos registros (SYNC_PROTOCOL.md §4.3) — só os campos que o site lê/edita.
// Leitores ignoram campos desconhecidos e os PRESERVAM ao regravar (merge por campo).

// 'elevenlabs' (desde 1.5.0, §4.3.1) é provedor de VOZ (TTS), não de chat.
export type ProviderKind = 'openai' | 'openrouter' | 'anthropic' | 'elevenlabs'

export const PROVIDER_KINDS: ProviderKind[] = ['openai', 'openrouter', 'anthropic', 'elevenlabs']
export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible (genérico)',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (API nativa)',
  elevenlabs: 'ElevenLabs (voz)'
}
export const PROVIDER_KIND_DEFAULT_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  elevenlabs: 'https://api.elevenlabs.io'
}

/** O que cada tipo serve: chat (LLM) e/ou voz (TTS/STT). */
export type ProviderCapability = 'chat' | 'tts' | 'stt'
export const PROVIDER_KIND_CAPABILITIES: Record<ProviderKind, readonly ProviderCapability[]> = {
  openai: ['chat', 'tts', 'stt'],
  openrouter: ['chat', 'tts', 'stt'],
  anthropic: ['chat'],
  elevenlabs: ['tts']
}

/** O tipo serve como provedor de chat (aparece nos seletores de modelo)? */
export const isChatProviderKind = (kind: ProviderKind): boolean =>
  PROVIDER_KIND_CAPABILITIES[kind].includes('chat')

export const isProviderKind = (v: unknown): v is ProviderKind =>
  typeof v === 'string' && (PROVIDER_KINDS as string[]).includes(v)

export function inferProviderKind(baseUrl: string): ProviderKind {
  const u = (typeof baseUrl === 'string' ? baseUrl : '').toLowerCase()
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('api.anthropic.com')) return 'anthropic'
  if (u.includes('elevenlabs.io')) return 'elevenlabs'
  return 'openai'
}

/** Host da URL (minúsculo); URL que não dá para interpretar → o próprio texto. */
function urlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

/**
 * Tipo efetivo de um provider: `kind` válido, ou inferido pela URL se ausente/desconhecido. Reparo
 * (§4.3.1, 1.5.0): `kind: 'openai'` com host `elevenlabs.io` é ElevenLabs — apps < 1.5.0 inferem
 * 'openai' para essa URL e podem ter regravado o tipo.
 */
export function providerKindOf(p: { baseUrl?: unknown; kind?: unknown }): ProviderKind {
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : ''
  if (!isProviderKind(p.kind)) return inferProviderKind(baseUrl)
  if (p.kind === 'openai' && urlHost(baseUrl).includes('elevenlabs.io')) return 'elevenlabs'
  return p.kind
}

/** O provider serve para chat (LLM)? Provedores só de voz (ElevenLabs) ficam fora de listas de chat. */
export const isChatProvider = (p: { baseUrl?: unknown; kind?: unknown }): boolean =>
  isChatProviderKind(providerKindOf(p))

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
  /** Desde 1.5.0 (§4.3.8): mensagem de voz (fala da chamada ou ditado) — ver data/voice.ts. */
  voice?: unknown
  /** Desde 1.5.0 (§4.3.8): marcador de chamada (`kind: 'voice-call'`) — ver data/voice.ts. */
  voiceCall?: unknown
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
