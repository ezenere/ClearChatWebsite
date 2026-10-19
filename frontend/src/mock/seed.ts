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
  }
): Promise<PushItem[]> {
  const chatId = crypto.randomUUID()
  const mainId = crypto.randomUUID()
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
  out.push(await session(mainId, 'Principal', 0, {}))
  const pushMsgs = async (sessionId: string, msgs: Msg[]) => {
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
        meta:
          m.role === 'assistant'
            ? {
                model: m.model ?? opts.model,
                usage: { promptTokens: 1800 + i * 300, completionTokens: 240 }
              }
            : {},
        createdAt: t
      }
      out.push(await item(sk, userId, 'message', crypto.randomUUID(), chatId, plain))
    }
  }
  await pushMsgs(mainId, opts.messages)
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
  for (const c of chats) server.remotePush(userId, c)
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
