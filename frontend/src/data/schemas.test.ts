import { describe, expect, it } from 'vitest'
import {
  inferProviderKind,
  isChatProvider,
  isChatProviderKind,
  isProviderKind,
  PROVIDER_KIND_DEFAULT_URL,
  PROVIDER_KIND_LABEL,
  PROVIDER_KINDS,
  providerKindOf
} from './schemas'

describe('tipos de provider (§4.3.1)', () => {
  it('inclui ElevenLabs como provedor só de voz', () => {
    expect(PROVIDER_KINDS).toContain('elevenlabs')
    expect(PROVIDER_KIND_LABEL.elevenlabs).toBe('ElevenLabs (voz)')
    expect(PROVIDER_KIND_DEFAULT_URL.elevenlabs).toBe('https://api.elevenlabs.io')
    expect(isChatProviderKind('elevenlabs')).toBe(false)
    for (const k of ['openai', 'openrouter', 'anthropic'] as const)
      expect(isChatProviderKind(k)).toBe(true)
    expect(isProviderKind('elevenlabs')).toBe(true)
    expect(isProviderKind('gemini')).toBe(false)
    expect(isProviderKind(undefined)).toBe(false)
  })

  it('infere pela URL', () => {
    expect(inferProviderKind('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(inferProviderKind('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(inferProviderKind('https://api.elevenlabs.io')).toBe('elevenlabs')
    expect(inferProviderKind('https://API.ElevenLabs.io/v1')).toBe('elevenlabs')
    expect(inferProviderKind('http://localhost:11434/v1')).toBe('openai')
    expect(inferProviderKind(undefined as unknown as string)).toBe('openai')
  })

  it('providerKindOf: kind válido vence; ausente/desconhecido → inferido', () => {
    expect(providerKindOf({ kind: 'anthropic', baseUrl: 'https://proxy.x/v1' })).toBe('anthropic')
    expect(providerKindOf({ kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io' })).toBe(
      'elevenlabs'
    )
    expect(providerKindOf({ baseUrl: 'https://openrouter.ai/api/v1' })).toBe('openrouter')
    expect(providerKindOf({ kind: 'gemini', baseUrl: 'https://api.elevenlabs.io' })).toBe(
      'elevenlabs'
    )
    expect(providerKindOf({ kind: 42, baseUrl: 7 })).toBe('openai')
    expect(providerKindOf({})).toBe('openai')
  })

  it('reparo: kind "openai" com host elevenlabs.io é ElevenLabs (apps < 1.5.0)', () => {
    expect(providerKindOf({ kind: 'openai', baseUrl: 'https://api.elevenlabs.io' })).toBe(
      'elevenlabs'
    )
    expect(
      providerKindOf({ kind: 'openai', baseUrl: 'https://api.eu.residency.elevenlabs.io/' })
    ).toBe('elevenlabs')
    expect(providerKindOf({ kind: 'openai', baseUrl: 'api.elevenlabs.io' })).toBe('elevenlabs')
    // só o host conta: um proxy OpenAI-compatible com "elevenlabs.io" no caminho continua openai
    expect(providerKindOf({ kind: 'openai', baseUrl: 'https://proxy.x/elevenlabs.io/v1' })).toBe(
      'openai'
    )
    expect(providerKindOf({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe('openai')
    // o reparo é só para 'openai'
    expect(providerKindOf({ kind: 'openrouter', baseUrl: 'https://api.elevenlabs.io' })).toBe(
      'openrouter'
    )
  })

  it('isChatProvider exclui provedores de voz (incl. o reparo)', () => {
    expect(isChatProvider({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })).toBe(
      true
    )
    expect(isChatProvider({ kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io' })).toBe(false)
    expect(isChatProvider({ kind: 'openai', baseUrl: 'https://api.elevenlabs.io' })).toBe(false)
    expect(isChatProvider({ baseUrl: 'https://api.elevenlabs.io' })).toBe(false)
  })
})
