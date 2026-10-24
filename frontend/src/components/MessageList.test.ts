// Renderização (SSR, sem DOM) das marcas de voz e dos marcadores de chamada (§4.3.8, 1.5.0).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Change } from '../api/types'
import type { Entry } from '../data/repo'
import type { ApiMessage, MessageMeta, MessagePlain } from '../data/schemas'
import { MessageList } from './MessageList'

let n = 0
function entry(message: ApiMessage, meta: MessageMeta = {}): Entry<MessagePlain> {
  n++
  const change: Change = {
    seq: n,
    type: 'message',
    id: `m${n}`,
    scope: 'c1',
    rev: 1,
    deleted: false,
    size: 10,
    blobs: [],
    device_id: 'd1',
    updated_at: new Date(0).toISOString()
  }
  return {
    change,
    plain: { sv: 1, sessionId: 's1', seq: n, message, meta, createdAt: 1_700_000_000_000 }
  }
}

const render = (messages: Entry<MessagePlain>[]) =>
  renderToStaticMarkup(createElement(MessageList, { messages }))

describe('MessageList: chamada de voz', () => {
  it('marcadores viram linhas divisórias (de meta.voiceCall, com o texto como reserva)', () => {
    const html = render([
      entry(
        { role: 'assistant', content: 'Chamada de voz iniciada' },
        {
          synthetic: true,
          // codificação do registro (§4.3.8): 'memory-extraction' + voiceCall, sem memoryExtraction
          kind: 'memory-extraction',
          voiceCall: { callId: 'c', phase: 'start', startedAt: 1_700_000_000_000 }
        }
      ),
      entry(
        { role: 'assistant', content: 'Chamada encerrada · 1 min · por você' },
        {
          synthetic: true,
          kind: 'voice-call',
          voiceCall: {
            callId: 'c',
            phase: 'end',
            startedAt: 1,
            durationMs: 252_000,
            endedBy: 'agent',
            usage: {
              turns: 1,
              userSpeechMs: 0,
              stt: {
                mode: 'local',
                apiRequests: 0,
                apiAudioMs: 0,
                localRequests: 2,
                costedRequests: 0
              },
              tts: { backend: 'api', chars: 10, audioMs: 0, cost: 0.003 },
              llm: { calls: 1, cost: 0.001, costed: 1 }
            }
          }
        }
      ),
      entry(
        { role: 'assistant', content: 'Texto do conteúdo' },
        { synthetic: true, kind: 'voice-call', voiceCall: 'lixo' }
      )
    ])
    expect(html.match(/data-testid="voice-call-marker"/g)).toHaveLength(3)
    expect(html).toMatch(/Chamada de voz iniciada · \d{2}:\d{2}/)
    expect(html).toContain('Chamada encerrada · 4 min 12 s · pelo agente · US$ 0,0040')
    expect(html).toContain('title="Turnos de voz: 1')
    expect(html).toContain('Texto do conteúdo')
    // não renderiza o conteúdo como resposta (markdown)
    expect(html).not.toContain('class="md"')
  })

  it('fala da chamada em itálico com microfone (usuário) e alto-falante (assistente)', () => {
    const html = render([
      entry(
        { role: 'user', content: 'Oi, tudo bem?' },
        { voice: { source: 'call', callId: 'c', durationMs: 3_240 } }
      ),
      entry(
        { role: 'assistant', content: 'Tudo ótimo!' },
        { voice: { source: 'call', callId: 'c', spoken: 'partial' } }
      )
    ])
    expect(html).toMatch(/<p class="[^"]*italic[^"]*">Oi, tudo bem\?<\/p>/)
    expect(html).toContain('<div class="italic"><div class="md">')
    expect(html).toContain('title="Falado na chamada de voz · 3,2 s"')
    expect(html).toContain('title="Resposta falada na chamada (em parte)"')
    expect(html).toContain('lucide-mic')
    expect(html).toContain('lucide-volume-2')
  })

  it('ditado: sem itálico, só o microfone', () => {
    const html = render([
      entry({ role: 'user', content: 'Texto ditado' }, { voice: { source: 'dictation' } })
    ])
    expect(html).not.toContain('italic')
    expect(html).toContain('title="Ditado por voz"')
  })

  it('meta.voice inválido é ignorado sem quebrar', () => {
    const html = render([
      entry({ role: 'user', content: 'Normal' }, { voice: 'call' }),
      entry({ role: 'assistant', content: 'Resposta' }, { voice: { source: 42 } })
    ])
    expect(html).not.toContain('voice-mark')
    expect(html).not.toContain('italic')
    expect(html).toContain('Normal')
  })
})
