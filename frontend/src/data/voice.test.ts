import { describe, expect, it } from 'vitest'
import {
  callMarkLabel,
  callMarkTooltip,
  callReportedCost,
  endedByText,
  formatCallDuration,
  formatSeconds,
  formatUsd,
  isVoiceCallDisabled,
  isVoiceCallMarker,
  readVoiceCallMark,
  readVoiceMeta,
  voiceMessageTitle,
  type VoiceCallUsage
} from './voice'

const usage = (over: Partial<VoiceCallUsage['tts']> = {}): VoiceCallUsage => ({
  turns: 3,
  userSpeechMs: 9_000,
  stt: {
    mode: 'api',
    model: 'whisper-1',
    apiRequests: 5,
    apiAudioMs: 12_000,
    localRequests: 0,
    cost: 0.002,
    costedRequests: 5
  },
  tts: { backend: 'elevenlabs', model: 'eleven_flash_v2_5', chars: 300, audioMs: 20_000, ...over },
  llm: { calls: 3, cost: 0.0103, costed: 3 }
})

describe('formatação', () => {
  it('formatCallDuration', () => {
    expect(formatCallDuration(0)).toBe('0 s')
    expect(formatCallDuration(38_400)).toBe('38 s')
    expect(formatCallDuration(60_000)).toBe('1 min')
    expect(formatCallDuration(252_000)).toBe('4 min 12 s')
    expect(formatCallDuration(3_720_000)).toBe('1 h 02 min')
    expect(formatCallDuration(-5)).toBe('0 s')
    expect(formatCallDuration(NaN)).toBe('0 s')
  })

  it('formatSeconds e formatUsd', () => {
    expect(formatSeconds(3_240)).toBe('3,2 s')
    expect(formatSeconds(-1)).toBe('0,0 s')
    expect(formatUsd(0)).toBe('US$ 0,00')
    expect(formatUsd(0.00001)).toBe('<US$ 0,0001')
    expect(formatUsd(0.0123)).toBe('US$ 0,0123')
    expect(formatUsd(1.5)).toBe('US$ 1,50')
    expect(formatUsd(0.0042)).toBe('US$ 0,0042')
    expect(formatUsd(1234.5)).toBe('US$ 1.234,50')
  })

  it('endedByText', () => {
    expect(endedByText({ endedBy: 'user' })).toBe('por você')
    expect(endedByText({})).toBe('por você')
    expect(endedByText({ endedBy: 'agent', reason: 'tchau' })).toBe('pelo agente')
    expect(endedByText({ endedBy: 'error', reason: 'microfone sumiu' })).toBe(
      'erro: microfone sumiu'
    )
    expect(endedByText({ endedBy: 'error' })).toBe('erro')
  })
})

describe('custo da chamada', () => {
  it('soma STT + LLM e a TTS só quando não é estimativa', () => {
    expect(callReportedCost(undefined)).toBe(0)
    expect(callReportedCost(usage({ cost: 0.01 }))).toBeCloseTo(0.0223)
    expect(callReportedCost(usage({ cost: 0.01, estimated: true }))).toBeCloseTo(0.0123)
    expect(callReportedCost(usage())).toBeCloseTo(0.0123)
  })

  it('não quebra com usage malformado', () => {
    expect(callReportedCost({} as VoiceCallUsage)).toBe(0)
  })
})

describe('leituras defensivas', () => {
  it('readVoiceMeta', () => {
    expect(readVoiceMeta(undefined)).toBeNull()
    expect(readVoiceMeta('call')).toBeNull()
    expect(readVoiceMeta({ source: 'phone' })).toBeNull()
    expect(readVoiceMeta([])).toBeNull()
    expect(
      readVoiceMeta({ source: 'call', callId: 'c1', durationMs: 3200, spoken: 'yes', x: 1 })
    ).toEqual({ source: 'call', callId: 'c1', durationMs: 3200 })
    expect(readVoiceMeta({ source: 'call', spoken: 'partial', ttsModel: 'tts-1' })).toEqual({
      source: 'call',
      spoken: 'partial',
      ttsModel: 'tts-1'
    })
    expect(readVoiceMeta({ source: 'dictation', durationMs: 'x' })).toEqual({
      source: 'dictation'
    })
  })

  it('readVoiceCallMark', () => {
    expect(readVoiceCallMark(null)).toBeNull()
    expect(readVoiceCallMark({ phase: 'middle' })).toBeNull()
    expect(readVoiceCallMark({ phase: 'start', callId: 'c', startedAt: 'ontem' })).toEqual({
      callId: 'c',
      phase: 'start',
      startedAt: 0
    })
    const end = readVoiceCallMark({
      callId: 'c',
      phase: 'end',
      startedAt: 1000,
      durationMs: 252_000,
      endedBy: 'robot',
      usage: { turns: 2, stt: 'x', tts: { estimated: 'sim', cost: 0.5 } }
    })!
    expect(end.endedBy).toBeUndefined()
    expect(end.usage?.turns).toBe(2)
    expect(end.usage?.stt.cost).toBeUndefined()
    expect(end.usage?.tts.estimated).toBeUndefined()
    expect(end.usage?.tts.cost).toBe(0.5)
  })
})

describe('rótulos', () => {
  it('marcador de início', () => {
    expect(callMarkLabel({ callId: 'c', phase: 'start', startedAt: Date.now() }, '')).toMatch(
      /^Chamada de voz iniciada · \d{2}:\d{2}$/
    )
    expect(callMarkLabel({ callId: 'c', phase: 'start', startedAt: 0 }, '')).toBe(
      'Chamada de voz iniciada'
    )
  })

  it('marcador de fim', () => {
    const base = { callId: 'c', phase: 'end' as const, startedAt: 1, durationMs: 252_000 }
    expect(callMarkLabel({ ...base, endedBy: 'user' }, '')).toBe(
      'Chamada encerrada · 4 min 12 s · por você'
    )
    expect(callMarkLabel({ ...base, endedBy: 'error', reason: 'sem rede' }, '')).toBe(
      'Chamada encerrada · 4 min 12 s · erro: sem rede'
    )
    expect(callMarkLabel({ ...base, endedBy: 'agent', usage: usage({ cost: 0.01 }) }, '')).toBe(
      'Chamada encerrada · 4 min 12 s · pelo agente · US$ 0,0223'
    )
    expect(callMarkLabel({ ...base, usage: usage({ cost: 0.0142, estimated: true }) }, '')).toBe(
      'Chamada encerrada · 4 min 12 s · por você · US$ 0,0123 + ~US$ 0,0142 (voz, estimado)'
    )
    // sem durationMs: usa endedAt − startedAt
    expect(callMarkLabel({ callId: 'c', phase: 'end', startedAt: 1000, endedAt: 39_000 }, '')).toBe(
      'Chamada encerrada · 38 s · por você'
    )
  })

  it('sem voiceCall válido usa o texto da mensagem', () => {
    expect(callMarkLabel(null, 'Chamada encerrada · 1 min · por você')).toBe(
      'Chamada encerrada · 1 min · por você'
    )
    expect(callMarkLabel(null, '  ')).toBe('Chamada de voz')
  })

  it('tooltip do marcador', () => {
    expect(callMarkTooltip(null)).toBeUndefined()
    expect(callMarkTooltip({ callId: 'c', phase: 'start', startedAt: 1 })).toBeUndefined()
    const t = callMarkTooltip({
      callId: 'c',
      phase: 'end',
      startedAt: 1,
      usage: usage({ cost: 0.0142, estimated: true })
    })!
    expect(t).toContain('Turnos de voz: 3 (9 s de fala)')
    expect(t).toContain('Transcrição: API · whisper-1 · 5 req. à API · US$ 0,0020')
    expect(t).toContain(
      'Voz: ElevenLabs · eleven_flash_v2_5 · 300 caracteres · ~US$ 0,0142 (estimado)'
    )
    expect(t).toContain('Modelo: 3 resposta(s) · US$ 0,0103')
  })

  it('tooltip do ícone de voz', () => {
    expect(voiceMessageTitle('user', null)).toBeNull()
    expect(voiceMessageTitle('user', { source: 'dictation', durationMs: 900 })).toBe(
      'Ditado por voz'
    )
    expect(voiceMessageTitle('user', { source: 'call', durationMs: 3_240 })).toBe(
      'Falado na chamada de voz · 3,2 s'
    )
    expect(voiceMessageTitle('user', { source: 'call' })).toBe('Falado na chamada de voz')
    expect(voiceMessageTitle('assistant', { source: 'call', spoken: true })).toBe(
      'Resposta falada na chamada'
    )
    expect(voiceMessageTitle('assistant', { source: 'call', spoken: 'partial' })).toBe(
      'Resposta falada na chamada (em parte)'
    )
    expect(voiceMessageTitle('assistant', { source: 'call' })).toBe('Resposta na chamada de voz')
  })

  it('isVoiceCallDisabled', () => {
    expect(isVoiceCallDisabled({ voice: { enabled: false } })).toBe(true)
    expect(isVoiceCallDisabled({ voice: { enabled: true } })).toBe(false)
    expect(isVoiceCallDisabled({ voice: 'off' })).toBe(false)
    expect(isVoiceCallDisabled({})).toBe(false)
    expect(isVoiceCallDisabled(null)).toBe(false)
  })
})

describe('isVoiceCallMarker (codificação do registro, §4.3.8)', () => {
  it('reconhece memory-extraction + voiceCall e voice-call explícito; extração de verdade não', () => {
    expect(isVoiceCallMarker({ kind: 'memory-extraction', voiceCall: { phase: 'start' } })).toBe(
      true
    )
    expect(isVoiceCallMarker({ kind: 'voice-call', voiceCall: { phase: 'end' } })).toBe(true)
    expect(isVoiceCallMarker({ kind: 'memory-extraction', memoryExtraction: { created: 1 } })).toBe(
      false
    )
    expect(
      isVoiceCallMarker({
        kind: 'memory-extraction',
        voiceCall: { phase: 'start' },
        memoryExtraction: { created: 1 }
      })
    ).toBe(false)
    expect(isVoiceCallMarker({ kind: 'memory-extraction', voiceCall: 'lixo' })).toBe(false)
    expect(isVoiceCallMarker(null)).toBe(false)
  })
})
