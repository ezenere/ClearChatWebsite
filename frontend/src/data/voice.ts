// Chamada de voz no histórico (desde 1.5.0, §4.3.8): `meta.voice` das mensagens faladas/ditadas e os
// marcadores de início/fim da chamada (`meta.kind: 'voice-call'` + `meta.voiceCall`, mensagens só de
// exibição). Leituras defensivas: valor malformado vira `null`/padrão, nunca exceção. Funções puras
// portadas do app (src/shared/voiceCallMarks.ts).

/** Mensagem que veio de voz: fala da chamada (usuário/assistente) ou texto ditado no composer. */
export interface VoiceMessageMeta {
  source: 'call' | 'dictation'
  callId?: string
  /** Usuário: áudio da fala (ms). */
  durationMs?: number
  sttModel?: string
  /** Assistente: falada inteira (true) ou só em parte ('partial'). */
  spoken?: true | 'partial'
  ttsModel?: string
}

export type VoiceCallEndedBy = 'user' | 'agent' | 'error'

/** Custos/tempos de uma chamada (marcador de fim). Custos em US$. */
export interface VoiceCallUsage {
  turns: number
  userSpeechMs: number
  stt: {
    mode: string
    model?: string
    apiRequests: number
    apiAudioMs: number
    localRequests: number
    cost?: number
    costedRequests: number
  }
  tts: {
    backend: string
    model?: string
    chars: number
    audioMs: number
    cost?: number
    estimated?: boolean
  }
  llm: { calls: number; cost: number; costed: number }
}

export interface VoiceCallMark {
  callId: string
  phase: 'start' | 'end'
  startedAt: number
  endedAt?: number
  durationMs?: number
  endedBy?: VoiceCallEndedBy
  reason?: string
  usage?: VoiceCallUsage
}

export const VOICE_CALL_KIND = 'voice-call'

/**
 * A mensagem é um marcador de chamada (§4.3.8)? No registro o app grava `kind: 'memory-extraction'`
 * com `voiceCall` e sem `memoryExtraction` (assim apps ≤ 0.9.0, que mandariam um `kind` desconhecido
 * ao modelo, o descartam); `kind: 'voice-call'` explícito também vale.
 */
export function isVoiceCallMarker(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false
  const m = meta as Record<string, unknown>
  if (m.kind === VOICE_CALL_KIND) return true
  return (
    m.kind === 'memory-extraction' &&
    !!m.voiceCall &&
    typeof m.voiceCall === 'object' &&
    !Array.isArray(m.voiceCall) &&
    m.memoryExtraction == null
  )
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const n = (v: unknown): number => num(v) ?? 0
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** `meta.voice` validado; ausente/malformado → `null`. */
export function readVoiceMeta(v: unknown): VoiceMessageMeta | null {
  if (!isObj(v) || (v.source !== 'call' && v.source !== 'dictation')) return null
  const out: VoiceMessageMeta = { source: v.source }
  const callId = str(v.callId)
  if (callId) out.callId = callId
  const durationMs = num(v.durationMs)
  if (durationMs !== undefined && durationMs > 0) out.durationMs = durationMs
  const sttModel = str(v.sttModel)
  if (sttModel) out.sttModel = sttModel
  if (v.spoken === true || v.spoken === 'partial') out.spoken = v.spoken
  const ttsModel = str(v.ttsModel)
  if (ttsModel) out.ttsModel = ttsModel
  return out
}

function readUsage(v: unknown): VoiceCallUsage | undefined {
  if (!isObj(v)) return undefined
  const stt = isObj(v.stt) ? v.stt : {}
  const tts = isObj(v.tts) ? v.tts : {}
  const llm = isObj(v.llm) ? v.llm : {}
  return {
    turns: n(v.turns),
    userSpeechMs: n(v.userSpeechMs),
    stt: {
      mode: str(stt.mode) ?? '',
      model: str(stt.model),
      apiRequests: n(stt.apiRequests),
      apiAudioMs: n(stt.apiAudioMs),
      localRequests: n(stt.localRequests),
      cost: num(stt.cost),
      costedRequests: n(stt.costedRequests)
    },
    tts: {
      backend: str(tts.backend) ?? '',
      model: str(tts.model),
      chars: n(tts.chars),
      audioMs: n(tts.audioMs),
      cost: num(tts.cost),
      estimated: tts.estimated === true ? true : undefined
    },
    llm: { calls: n(llm.calls), cost: n(llm.cost), costed: n(llm.costed) }
  }
}

/** `meta.voiceCall` validado; ausente/malformado → `null`. */
export function readVoiceCallMark(v: unknown): VoiceCallMark | null {
  if (!isObj(v) || (v.phase !== 'start' && v.phase !== 'end')) return null
  const out: VoiceCallMark = {
    callId: str(v.callId) ?? '',
    phase: v.phase,
    startedAt: n(v.startedAt)
  }
  const endedAt = num(v.endedAt)
  if (endedAt !== undefined) out.endedAt = endedAt
  const durationMs = num(v.durationMs)
  if (durationMs !== undefined) out.durationMs = durationMs
  if (v.endedBy === 'user' || v.endedBy === 'agent' || v.endedBy === 'error')
    out.endedBy = v.endedBy
  const reason = str(v.reason)
  if (reason) out.reason = reason
  const usage = readUsage(v.usage)
  if (usage) out.usage = usage
  return out
}

/** "4 min 12 s", "38 s", "1 h 02 min" (pt-BR, arredondado ao segundo). */
export function formatCallDuration(ms: number): string {
  const s = Math.max(0, Math.round(n(ms) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}

/** Segundos com 1 casa (pt-BR): "3,2 s". */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, n(ms)) / 1000).toFixed(1).replace('.', ',')} s`
}

/** "por você" / "pelo agente" / "erro: <motivo>". */
export function endedByText(mark: Pick<VoiceCallMark, 'endedBy' | 'reason'>): string {
  if (mark.endedBy === 'agent') return 'pelo agente'
  if (mark.endedBy === 'error') return mark.reason ? `erro: ${mark.reason}` : 'erro'
  return 'por você'
}

/** Custo informado (STT) + LLM; a TTS só entra quando NÃO é estimativa. */
export function callReportedCost(u: VoiceCallUsage | undefined | null): number {
  if (!u) return 0
  return n(u.stt?.cost) + n(u.llm?.cost) + (u.tts?.estimated ? 0 : n(u.tts?.cost))
}

/** Valor em dólar pt-BR: US$ 0,00 · <US$ 0,0001 · US$ 0,0123 · US$ 1,50 · US$ 1.234,56. */
export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return 'US$ 0,00'
  if (cost < 0.0001) return '<US$ 0,0001'
  if (cost < 1) return `US$ ${cost.toFixed(4).replace('.', ',')}`
  const [int, dec] = cost.toFixed(2).split('.')
  return `US$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** Rótulo do marcador (linha divisória). `fallback` = o `content` da mensagem. */
export function callMarkLabel(mark: VoiceCallMark | null, fallback: string): string {
  if (!mark) return fallback.trim() || 'Chamada de voz'
  if (mark.phase === 'start')
    return mark.startedAt > 0
      ? `Chamada de voz iniciada · ${timeFmt.format(new Date(mark.startedAt))}`
      : 'Chamada de voz iniciada'
  const parts = ['Chamada encerrada']
  const dur =
    mark.durationMs ??
    (mark.endedAt !== undefined && mark.startedAt > 0 ? mark.endedAt - mark.startedAt : undefined)
  if (dur !== undefined) parts.push(formatCallDuration(dur))
  parts.push(endedByText(mark))
  const u = mark.usage
  if (u) {
    const cost = callReportedCost(u)
    parts.push(formatUsd(cost))
    const label = parts.join(' · ')
    return u.tts.estimated && u.tts.cost !== undefined && u.tts.cost > 0
      ? `${label} + ~${formatUsd(u.tts.cost)} (voz, estimado)`
      : label
  }
  return parts.join(' · ')
}

const STT_MODE: Record<string, string> = {
  api: 'API',
  local: 'local',
  hybrid: 'híbrido',
  gpu: 'GPU local'
}
const TTS_BACKEND: Record<string, string> = {
  api: 'API',
  elevenlabs: 'ElevenLabs',
  local: 'local',
  gpu: 'GPU local'
}

/** Tooltip do marcador de fim com o resumo de uso; sem `usage` → `undefined`. */
export function callMarkTooltip(mark: VoiceCallMark | null): string | undefined {
  const u = mark?.usage
  if (!u) return undefined
  const withModel = (label: string, model?: string) => (model ? `${label} · ${model}` : label)
  const lines = [
    `Turnos de voz: ${u.turns}` +
      (u.userSpeechMs > 0 ? ` (${formatCallDuration(u.userSpeechMs)} de fala)` : ''),
    `Transcrição: ${withModel(STT_MODE[u.stt.mode] ?? (u.stt.mode || '—'), u.stt.model)}` +
      (u.stt.apiRequests ? ` · ${u.stt.apiRequests} req. à API` : '') +
      (u.stt.localRequests ? ` · ${u.stt.localRequests} locais` : '') +
      (u.stt.cost !== undefined ? ` · ${formatUsd(u.stt.cost)}` : ''),
    `Voz: ${withModel(TTS_BACKEND[u.tts.backend] ?? (u.tts.backend || '—'), u.tts.model)}` +
      (u.tts.chars ? ` · ${u.tts.chars.toLocaleString('pt-BR')} caracteres` : '') +
      (u.tts.cost !== undefined
        ? ` · ${u.tts.estimated ? '~' : ''}${formatUsd(u.tts.cost)}${u.tts.estimated ? ' (estimado)' : ''}`
        : ''),
    `Modelo: ${u.llm.calls} resposta(s)` + (u.llm.costed ? ` · ${formatUsd(u.llm.cost)}` : '')
  ]
  return lines.join('\n')
}

/** Tooltip do ícone de voz de uma mensagem; `null` = sem marca de voz. */
export function voiceMessageTitle(role: string, v: VoiceMessageMeta | null): string | null {
  if (!v) return null
  if (v.source === 'dictation') return 'Ditado por voz'
  if (role === 'assistant') {
    if (!v.spoken) return 'Resposta na chamada de voz'
    return `Resposta falada na chamada${v.spoken === 'partial' ? ' (em parte)' : ''}`
  }
  return `Falado na chamada de voz${v.durationMs ? ` · ${formatSeconds(v.durationMs)}` : ''}`
}

/** `config.voice.enabled === false` → chamada desligada no chat (§4.3.6). */
export function isVoiceCallDisabled(config: unknown): boolean {
  return isObj(config) && isObj(config.voice) && config.voice.enabled === false
}
