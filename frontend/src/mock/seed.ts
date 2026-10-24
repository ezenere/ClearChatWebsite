// Conta de demonstração do servidor simulado (dados fictícios, cifrados de verdade no "cliente").
import {
  ARGON2_DEFAULT,
  createKeyMaterial,
  deriveSubkeys,
  fromHex,
  hex,
  sealRecord,
  type Subkeys
} from '../crypto'
import type { PushItem } from '../api/types'
import type {
  ChatPlain,
  MessagePlain,
  ProviderPlain,
  SessionPlain,
  SettingPlain
} from '../data/schemas'
import type { MockServer } from './server'

export const DEMO = {
  email: 'demo@clearchat.dev',
  name: 'Ana Demo',
  password: 'demonstracao-segura'
}
/** Argon2id com os parâmetros MÍNIMOS aceitos (só para a conta de demonstração abrir rápido). */
export const DEMO_KDF = { ...ARGON2_DEFAULT, m: 19456, t: 2 }

const H = 3600_000
const D = 24 * H

async function item(
  sk: Subkeys,
  userId: string,
  type: string,
  id: string,
  scope: string | null,
  plain: Record<string, unknown>
): Promise<PushItem> {
  const env = await sealRecord(sk.record, userId, { type, id, scope, rev: 1 }, plain)
  return { type, id, scope, base_rev: 0, rev: 1, deleted: false, env, blobs: [] }
}

interface Msg {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  reasoning?: string
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[]
  tool_call_id?: string
  model?: string
  /** Árvore de versões (§4.3.8): rótulo local desta mensagem… */
  key?: string
  /** …e o rótulo da mãe (`null` = raiz; ausente = a anterior da lista). */
  parent?: string | null
  /** Campos extras do `meta` (ex.: `voice`); com `synthetic: true` substitui o meta padrão. */
  meta?: MessagePlain['meta']
}

async function chatItems(
  sk: Subkeys,
  userId: string,
  opts: {
    title: string
    at: number
    model: string
    providerId: string
    messages: Msg[]
    sub?: { title: string; task: string; parentToolCallId: string; messages: Msg[] }
    /**
     * Conversa com versões (app ≥ 0.7): grava `parentId` em todas as mensagens e o `branchSel` da
     * sessão principal (rótulos `key` → ids). Sem isso, registros como os de um cliente antigo.
     */
    branchSel?: Record<string, string | null>
  }
): Promise<PushItem[]> {
  const chatId = crypto.randomUUID()
  const mainId = crypto.randomUUID()
  const tree = opts.branchSel !== undefined
  const mainIds = opts.messages.map(() => crypto.randomUUID())
  const idOf = (key: string) => {
    const i = opts.messages.findIndex((m) => m.key === key)
    if (i < 0) throw new Error(`seed: rótulo desconhecido ${key}`)
    return mainIds[i]
  }
  const out: PushItem[] = []
  const chat: ChatPlain = {
    sv: 1,
    title: opts.title,
    config: {
      providerId: opts.providerId,
      model: opts.model,
      enabledTools: ['shell', 'read_file']
    },
    mainSessionId: mainId,
    createdAt: opts.at - 2 * H,
    updatedAt: opts.at
  }
  out.push(await item(sk, userId, 'chat', chatId, chatId, chat))
  const session = (id: string, title: string, depth: number, extra: Partial<SessionPlain>) =>
    item(sk, userId, 'session', id, chatId, {
      sv: 1,
      chatId,
      parentSessionId: null,
      parentToolCallId: null,
      depth,
      model: opts.model,
      providerId: opts.providerId,
      title,
      task: null,
      status: 'idle',
      createdAt: opts.at - 2 * H,
      memory: null,
      ...extra
    } satisfies SessionPlain)
  out.push(
    await session(
      mainId,
      'Principal',
      0,
      tree
        ? {
            branchSel: Object.fromEntries(
              Object.entries(opts.branchSel!).map(([k, v]) => [
                k === 'root' ? k : idOf(k),
                v === null ? null : idOf(v)
              ])
            )
          }
        : {}
    )
  )
  const pushMsgs = async (sessionId: string, msgs: Msg[], ids?: string[]) => {
    let t = opts.at - msgs.length * 60_000
    for (const [i, m] of msgs.entries()) {
      t += 60_000
      const message =
        m.role === 'tool'
          ? { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content ?? '' }
          : m.role === 'assistant'
            ? {
                role: 'assistant' as const,
                content: m.content,
                ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                ...(m.tool_calls
                  ? {
                      tool_calls: m.tool_calls.map((c) => ({
                        id: c.id,
                        type: 'function' as const,
                        function: { name: c.name, arguments: JSON.stringify(c.args) }
                      }))
                    }
                  : {})
              }
            : { role: 'user' as const, content: m.content ?? '' }
      const plain: MessagePlain = {
        sv: 1,
        sessionId,
        seq: i + 1,
        message,
        meta: m.meta?.synthetic
          ? m.meta
          : {
              ...(m.role === 'assistant'
                ? {
                    model: m.model ?? opts.model,
                    usage: { promptTokens: 1800 + i * 300, completionTokens: 240 }
                  }
                : {}),
              ...m.meta
            },
        createdAt: t,
        ...(ids
          ? {
              parentId: m.parent === undefined ? (ids[i - 1] ?? null) : m.parent && idOf(m.parent)
            }
          : {})
      }
      out.push(await item(sk, userId, 'message', ids?.[i] ?? crypto.randomUUID(), chatId, plain))
    }
  }
  await pushMsgs(mainId, opts.messages, tree ? mainIds : undefined)
  if (opts.sub) {
    const subId = crypto.randomUUID()
    out.push(
      await session(subId, opts.sub.title, 1, {
        parentSessionId: mainId,
        parentToolCallId: opts.sub.parentToolCallId,
        task: opts.sub.task,
        model: 'anthropic/claude-haiku-4.5'
      })
    )
    await pushMsgs(subId, opts.sub.messages)
  }
  return out
}

export async function seedDemo(server: MockServer): Promise<void> {
  const userId = crypto.randomUUID()
  const { dek, body, recoveryKey } = await createKeyMaterial(userId, DEMO.password, DEMO_KDF)
  const sk = await deriveSubkeys(dek)
  const now = Date.now()
  server.addUser({
    id: userId,
    email: DEMO.email,
    name: DEMO.name,
    created_at: new Date(now - 40 * D).toISOString(),
    keys_ready: true,
    keys: { key_version: 1, keys_rev: 1, password: body.password, recovery: body.recovery },
    verifier: body.verifier
  })
  server.addDevice({
    user_id: userId,
    name: 'PC de casa',
    platform: 'linux',
    client: 'desktop',
    app_version: '0.6.0',
    can_host: true,
    created_at: new Date(now - 40 * D).toISOString(),
    last_seen_at: new Date(now - 2 * 60_000).toISOString(),
    last_ip: '189.6.12.40',
    fake_online: true
  })
  server.addDevice({
    user_id: userId,
    name: 'MacBook do trabalho',
    platform: 'macos',
    client: 'desktop',
    app_version: '0.5.9',
    can_host: true,
    created_at: new Date(now - 20 * D).toISOString(),
    last_seen_at: new Date(now - 3 * D).toISOString(),
    last_ip: '200.147.3.9'
  })
  server.db.demo = {
    user_id: userId,
    dek_hex: hex(dek),
    password: DEMO.password,
    email: DEMO.email,
    recovery_key: recoveryKey
  }

  const orId = crypto.randomUUID()
  const anId = crypto.randomUUID()
  const olId = crypto.randomUUID()
  const elId = crypto.randomUUID()
  const providers: [string, ProviderPlain][] = [
    [
      orId,
      {
        sv: 1,
        name: 'OpenRouter',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-v1-3f9a0c7e1b2d4f6a8c0e2b4d6f8a0c1e',
        headers: {},
        createdAt: now - 39 * D
      }
    ],
    [
      anId,
      {
        sv: 1,
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-api03-7c1e9b2d4f6a8c0e2b4d6f8a0c1e3f5a',
        headers: {},
        createdAt: now - 30 * D
      }
    ],
    [
      olId,
      {
        sv: 1,
        name: 'Ollama local',
        kind: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        headers: {},
        createdAt: now - 10 * D,
        // campo desconhecido de uma versão futura: o site precisa preservá-lo ao regravar
        futureField: { keep: true }
      }
    ],
    [
      elId,
      {
        sv: 1,
        name: 'ElevenLabs',
        kind: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io',
        apiKey: 'sk_9d2f4b6a8c0e1f3a5c7e9b1d3f5a7c9e',
        headers: {},
        createdAt: now - 5 * D
      }
    ]
  ]
  const settings: [string, SettingPlain][] = [
    ['webSearchApiKeys', { sv: 1, value: { exa: 'exa_demo_8f2c41d0b7e6' } }],
    [
      'webSearchEngines',
      {
        sv: 1,
        value: [
          { id: 'exa', enabled: true, options: { maxResults: 5 } },
          { id: 'ddg', enabled: true, options: {} },
          { id: 'brave-api', enabled: false, options: {} },
          { id: 'tavily', enabled: false, options: { depth: 'basic' } }
        ]
      }
    ],
    ['defaultModel', { sv: 1, value: { providerId: orId, model: 'anthropic/claude-sonnet-4.5' } }]
  ]
  const base: PushItem[] = []
  for (const [id, p] of providers) base.push(await item(sk, userId, 'provider', id, null, p))
  for (const [id, s] of settings) base.push(await item(sk, userId, 'setting', id, null, s))
  server.remotePush(userId, base)

  const chats = [
    await chatItems(sk, userId, {
      title: 'Refatorar o parser de SSE',
      at: now - 25 * 60_000,
      model: 'anthropic/claude-sonnet-4.5',
      providerId: orId,
      messages: [
        {
          role: 'user',
          content:
            'O parser de SSE em `src/main/sse.ts` quebra quando o servidor manda um evento sem `\\n` no final. Pode refatorar e rodar os testes?'
        },
        {
          role: 'assistant',
          reasoning:
            'Preciso ver o parser atual e onde ele é usado antes de mudar. Vou delegar o mapeamento dos usos a um subagente e rodar os testes.',
          content:
            'Antes de aplicar, vou delegar a um subagente o mapeamento dos outros usos do parser e rodar os testes.',
          tool_calls: [
            { id: 'call_sub1', name: 'delegate', args: { task: 'Mapear usos do parser' } },
            { id: 'call_sh1', name: 'shell', args: { command: 'npm test -- --run src/main/agent' } }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_sub1',
          content:
            '3 usos: src/main/agent/runner.ts, src/main/providers/openai.ts, src/main/providers/anthropic.ts'
        },
        {
          role: 'tool',
          tool_call_id: 'call_sh1',
          content:
            ' ✓ src/main/agent/runner.test.ts (24 testes)\n ✗ src/main/sse.test.ts > evento sem \\n final\n\nTest Files  1 failed | 1 passed (2)'
        },
        {
          role: 'assistant',
          content:
            "Encontrei o problema: o buffer só é processado quando chega `\\n\\n`. A correção é **descarregar o resto do buffer no fim do stream**:\n\n```ts\nexport function* parseSSE(chunks: Iterable<string>) {\n  let buf = ''\n  for (const chunk of chunks) {\n    buf += chunk\n    let i: number\n    while ((i = buf.indexOf('\\n\\n')) >= 0) {\n      yield parseEvent(buf.slice(0, i))\n      buf = buf.slice(i + 2)\n    }\n  }\n  if (buf.trim()) yield parseEvent(buf) // evento final sem \\n\n}\n```\n\nDepois da mudança:\n\n- `runner.ts` continua igual (usa o gerador);\n- os dois adaptadores ganharam um teste para o caso sem `\\n`;\n- **26 testes passando**."
        }
      ],
      sub: {
        title: 'Mapear usos do parser',
        task: 'Encontre todos os lugares em src/ que chamam parseSSE e liste.',
        parentToolCallId: 'call_sub1',
        messages: [
          {
            role: 'user',
            content: 'Encontre todos os lugares em src/ que chamam parseSSE e liste.'
          },
          {
            role: 'assistant',
            content:
              'Usos de `parseSSE`:\n\n1. `src/main/agent/runner.ts`\n2. `src/main/providers/openai.ts`\n3. `src/main/providers/anthropic.ts`',
            model: 'anthropic/claude-haiku-4.5'
          }
        ]
      }
    }),
    // versões (app 0.7): a 2ª pergunta foi editada e a resposta da versão nova foi regenerada; no app
    // está escolhida a 1ª resposta (não a mais nova)
    await chatItems(sk, userId, {
      title: 'Roteiro de 3 dias em Lisboa',
      at: now - 50 * 60_000,
      model: 'anthropic/claude-sonnet-4.5',
      providerId: orId,
      branchSel: { u2b: 'a2b' },
      messages: [
        { key: 'u1', role: 'user', content: 'Monta um roteiro de 3 dias em Lisboa, sem pressa.' },
        {
          key: 'a1',
          role: 'assistant',
          content:
            '**Dia 1** — Baixa, Chiado e pôr do sol no Miradouro de Santa Catarina.\n\n**Dia 2** — Belém: mosteiro, torre e pastéis.\n\n**Dia 3** — Alfama de manhã e LX Factory à tarde.'
        },
        { key: 'u2', role: 'user', content: 'Troca o dia 2 por um bate-volta para Sintra.' },
        {
          key: 'a2',
          role: 'assistant',
          content:
            'Feito: **Dia 2 em Sintra** — Palácio da Pena cedo, Quinta da Regaleira depois do almoço. Belém fica para outra viagem.'
        },
        {
          key: 'u2b',
          parent: 'a1',
          role: 'user',
          content: 'Troca o dia 3 por um bate-volta para Sintra.'
        },
        {
          key: 'a2b',
          role: 'assistant',
          content:
            'Feito: **Dia 3 em Sintra** — trem do Rossio às 8h, Palácio da Pena e Quinta da Regaleira. Alfama passa para a manhã do dia 1.'
        },
        {
          key: 'a2c',
          parent: 'u2b',
          role: 'assistant',
          content:
            'Combinado: **Dia 3 em Sintra e Cascais** — Pena de manhã, almoço em Sintra e fim de tarde na praia em Cascais.'
        }
      ]
    }),
    await chatItems(sk, userId, {
      title: 'Ideias de nomes para o app',
      at: now - 2 * H,
      model: 'claude-opus-4-1',
      providerId: anId,
      messages: [
        { role: 'user', content: 'Me dá 5 ideias de nome para um app de chat minimalista com IA.' },
        {
          role: 'assistant',
          content:
            'Algumas ideias, com a intenção por trás:\n\n1. **ClearChat** — transparência: você vê o que vai para a API.\n2. **Lume** — leve e claro.\n3. **Quieto** — sem distrações.\n4. **Fio** — a conversa como um fio contínuo.\n5. **Nítido** — direto ao ponto.\n\n> Dica: confira se o domínio `.com` e o nome no GitHub estão livres antes de decidir.'
        }
      ]
    }),
    await chatItems(sk, userId, {
      title: 'Resumo do artigo sobre CRDTs',
      at: now - 2 * D,
      model: 'anthropic/claude-sonnet-4.5',
      providerId: orId,
      messages: [
        { role: 'user', content: 'Resume o artigo sobre CRDTs que eu colei, em tópicos.' },
        {
          role: 'assistant',
          content:
            '## Resumo\n\nCRDTs (*Conflict-free Replicated Data Types*) permitem que réplicas aceitem escritas sem coordenação e **convirjam** para o mesmo estado.\n\n### Tipos principais\n\n| Tipo | Ideia | Exemplo |\n|---|---|---|\n| Estado (CvRDT) | junta estados com *merge* associativo | G-Counter |\n| Operação (CmRDT) | transmite operações comutativas | RGA (texto) |\n\n### Prós e contras\n\n- ✓ funciona offline\n- ✓ sem servidor central de ordem\n- ✗ metadados crescem (tombstones)\n- ✗ nem toda regra de negócio é comutativa\n\nPara um app de chat, o artigo sugere **LWW por campo** em configurações e um log ordenado pelo servidor para mensagens — parecido com o que o ClearChat faz no sync.'
        }
      ]
    }),
    await chatItems(sk, userId, {
      title: 'Script de backup com rsync',
      at: now - 6 * D,
      model: 'llama3.1:8b',
      providerId: olId,
      messages: [
        {
          role: 'user',
          content: 'Escreve um script de backup diário com rsync para um HD externo.'
        },
        {
          role: 'assistant',
          content:
            'Aqui vai um script simples e seguro (não apaga nada no destino sem `--delete`):\n\n```bash\n#!/usr/bin/env bash\nset -euo pipefail\nSRC="$HOME/"\nDEST="/run/media/$USER/Backup/home"\nrsync -aHAX --info=progress2 \\\n  --exclude=".cache" --exclude="node_modules" \\\n  "$SRC" "$DEST"\n```\n\nAgende com `systemd --user` ou `cron` (`0 3 * * *`).'
        }
      ]
    })
  ]
  chats.push(await voiceCallChat(sk, userId, now - 4 * H, orId))
  for (const c of chats) server.remotePush(userId, c)
}

/** Conversa com uma chamada de voz (1.5.0): marcadores de início/fim, falas e um ditado. */
async function voiceCallChat(
  sk: Subkeys,
  userId: string,
  at: number,
  providerId: string
): Promise<PushItem[]> {
  const callId = crypto.randomUUID()
  // mesmo relógio do `pushMsgs`: a mensagem i (0-based) de 8 fica em at - 8 min + (i + 1) min
  const startedAt = at - 7 * 60_000
  const endedAt = at - 3 * 60_000
  const sttModel = 'openai/whisper-large-v3-turbo'
  const ttsModel = 'eleven_flash_v2_5'
  return chatItems(sk, userId, {
    title: 'Chamada: planejar a semana',
    at,
    model: 'anthropic/claude-sonnet-4.5',
    providerId,
    messages: [
      {
        role: 'assistant',
        content: 'Chamada de voz iniciada',
        meta: {
          synthetic: true,
          // no registro o marcador vai como 'memory-extraction' + voiceCall (§4.3.8)
          kind: 'memory-extraction',
          voiceCall: { callId, phase: 'start', startedAt }
        }
      },
      {
        role: 'user',
        content: 'Me ajuda a organizar a semana? Tenho três entregas e a academia.',
        meta: { voice: { source: 'call', callId, durationMs: 4200, sttModel } }
      },
      {
        role: 'assistant',
        content:
          'Claro! Que tal as entregas de manhã, quando você rende mais, e a academia no fim da tarde de segunda, quarta e sexta?',
        meta: { voice: { source: 'call', callId, spoken: true, ttsModel } }
      },
      {
        role: 'user',
        content: 'Pode ser. Mas quinta eu tenho reunião o dia todo.',
        meta: { voice: { source: 'call', callId, durationMs: 3100, sttModel } }
      },
      {
        role: 'assistant',
        content:
          'Então a quinta fica livre de entregas. Passo a terceira para sexta de manhã e deixo a tarde de quinta só para descansar e revisar o que…',
        meta: { voice: { source: 'call', callId, spoken: 'partial', ttsModel } }
      },
      {
        role: 'assistant',
        content: 'Chamada encerrada · 4 min · por você',
        meta: {
          synthetic: true,
          // no registro o marcador vai como 'memory-extraction' + voiceCall (§4.3.8)
          kind: 'memory-extraction',
          voiceCall: {
            callId,
            phase: 'end',
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
            endedBy: 'user',
            usage: {
              turns: 2,
              userSpeechMs: 7300,
              stt: {
                mode: 'api',
                model: sttModel,
                apiRequests: 6,
                apiAudioMs: 11800,
                localRequests: 0,
                cost: 0.0009,
                costedRequests: 6
              },
              tts: {
                backend: 'elevenlabs',
                model: ttsModel,
                chars: 236,
                audioMs: 15400,
                cost: 0.0142,
                estimated: true
              },
              llm: { calls: 2, cost: 0.0114, costed: 2 }
            }
          }
        }
      },
      {
        role: 'user',
        content: 'Resume o plano da semana em uma lista curta.',
        meta: { voice: { source: 'dictation', durationMs: 2600, sttModel } }
      },
      {
        role: 'assistant',
        content:
          '- **Seg, qua e sex** — entregas de manhã, academia no fim da tarde\n- **Ter** — entrega 2\n- **Qui** — reunião; sem entregas\n- **Sex** — entrega 3 de manhã'
      }
    ]
  })
}

/** Simula outro dispositivo criando uma conversa na conta de demonstração. */
export async function remoteNewChat(
  server: MockServer,
  title = 'Conversa criada no celular'
): Promise<void> {
  const demo = server.db.demo
  if (!demo) return
  const sk = await deriveSubkeys(fromHex(demo.dek_hex))
  const items = await chatItems(sk, demo.user_id, {
    title,
    at: Date.now(),
    model: 'anthropic/claude-sonnet-4.5',
    providerId: 'x',
    messages: [
      { role: 'user', content: 'Oi! Teste de sincronização.' },
      { role: 'assistant', content: 'Recebido — esta conversa veio de outro dispositivo.' }
    ]
  })
  server.remotePush(demo.user_id, items)
}
