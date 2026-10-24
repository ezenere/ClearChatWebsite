// "Ver request": cada pedaço do chat acende as linhas do body que ele vira na API. Passa sozinho
// pelos pedaços até alguém passar o mouse (ou tocar) em um deles.
import { useEffect, useState } from 'react'
import { Brain, Gauge, Terminal, User, UserRound, Wrench } from 'lucide-react'
import { cx } from '../../components/ui'
import { CountUp } from './fx'
import { useInView } from './hooks'

type Key = 'persona' | 'memory' | 'user' | 'tool' | 'tools' | 'params'

const PIECES: { key: Key; icon: typeof User; label: string; text: string }[] = [
  { key: 'persona', icon: UserRound, label: 'Persona', text: 'Revisor — direto, cita o arquivo' },
  { key: 'memory', icon: Brain, label: 'Memória', text: 'Perfil: prefere respostas curtas' },
  { key: 'user', icon: User, label: 'Você', text: 'Roda os testes e me diz o que quebrou' },
  { key: 'tool', icon: Terminal, label: 'Ferramenta', text: 'shell · npm test' },
  { key: 'tools', icon: Wrench, label: 'Ferramentas ativas', text: 'shell, read_file, web_search' },
  { key: 'params', icon: Gauge, label: 'Parâmetros', text: 'esforço de raciocínio: médio' }
]

// [texto, chave]; chave vazia = estrutura
const LINES: [string, Key | ''][] = [
  ['{', ''],
  ['  "model": "anthropic/claude-sonnet-4.5",', ''],
  ['  "messages": [', ''],
  ['    { "role": "system",', 'persona'],
  ['      "content": "Você é o Revisor. Seja direto e cite o arquivo…" },', 'persona'],
  ['    { "role": "system",', 'memory'],
  ['      "content": "## Memória · Perfil\\n- Prefere respostas curtas" },', 'memory'],
  ['    { "role": "user",', 'user'],
  ['      "content": "Roda os testes e me diz o que quebrou" },', 'user'],
  ['    { "role": "assistant", "tool_calls": [{', 'tool'],
  ['      "function": { "name": "shell",', 'tool'],
  ['        "arguments": "{\\"command\\":\\"npm test\\"}" } }] }', 'tool'],
  ['  ],', ''],
  ['  "tools": [', 'tools'],
  ['    { "type": "function", "function": { "name": "shell", … } },', 'tools'],
  ['    { "type": "function", "function": { "name": "read_file", … } },', 'tools'],
  ['    { "type": "function", "function": { "name": "web_search", … } }', 'tools'],
  ['  ],', 'tools'],
  ['  "reasoning": { "effort": "medium" },', 'params'],
  ['  "stream": true', 'params'],
  ['}', '']
]

function paint(line: string) {
  // realce simples: chaves, strings e pontuação
  const out: React.ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(<span key={k++}>{line.slice(last, m.index)}</span>)
    out.push(
      <span key={k++} className={m[2] ? 'text-accent-strong' : 'text-[#9be7c4]'}>
        {m[1]}
      </span>
    )
    if (m[2]) out.push(<span key={k++}>{m[2]}</span>)
    last = m.index + m[0].length
  }
  if (last < line.length) out.push(<span key={k}>{line.slice(last)}</span>)
  return out
}

export function RequestInspector() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const [active, setActive] = useState<Key>('persona')
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (!inView || manual) return
    const id = setInterval(() => {
      setActive((a) => PIECES[(PIECES.findIndex((p) => p.key === a) + 1) % PIECES.length].key)
    }, 2200)
    return () => clearInterval(id)
  }, [inView, manual])

  const pick = (k: Key) => {
    setManual(true)
    setActive(k)
  }

  return (
    <div ref={ref} className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr] [&>*]:min-w-0">
      <div className="flex flex-col gap-2" role="listbox" aria-label="Partes do chat">
        {PIECES.map((p) => {
          const Icon = p.icon
          const on = active === p.key
          return (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={on}
              onPointerEnter={(e) => e.pointerType === 'mouse' && pick(p.key)}
              onFocus={() => pick(p.key)}
              onClick={() => pick(p.key)}
              className={cx(
                'group flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-300',
                on
                  ? 'translate-x-1 border-accent/45 bg-accent-soft shadow-[0_0_30px_-10px_rgb(139_92_246/0.8)]'
                  : 'border-border bg-surface/60 hover:border-border-strong'
              )}
            >
              <span
                className={cx(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
                  on ? 'border-accent/40 text-accent-strong' : 'border-border text-subtle'
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11.5px] font-medium tracking-wide text-subtle uppercase">
                  {p.label}
                </span>
                <span className="block truncate text-[14px] text-fg">{p.text}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="glass overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5 text-[12px]">
          <span className="font-mono text-subtle">POST /chat/completions · body exato</span>
          <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent-strong">
            Ver request
          </span>
        </div>
        <pre className="overflow-x-auto py-3 font-mono text-[11.5px] leading-[1.7] sm:text-[12px]">
          {LINES.map(([text, key], n) => {
            const hit = key === active
            return (
              <div
                key={n}
                className={cx(
                  'border-l-2 px-4 whitespace-pre transition-all duration-300',
                  hit
                    ? 'border-accent bg-accent/[0.09] text-fg'
                    : key
                      ? 'border-transparent text-subtle/70'
                      : 'border-transparent text-subtle'
                )}
              >
                {hit ? paint(text) : text}
              </div>
            )
          })}
        </pre>
        <div className="grid grid-cols-3 border-t border-border/70 text-center text-[11.5px] text-subtle">
          <div className="px-2 py-2.5">
            <p className="font-mono text-[15px] text-fg tabular-nums">
              <CountUp to={4812} format={(n) => Math.round(n).toLocaleString('pt-BR')} />
            </p>
            tokens de entrada
          </div>
          <div className="border-x border-border/70 px-2 py-2.5">
            <p className="font-mono text-[15px] text-success tabular-nums">
              <CountUp to={4096} format={(n) => Math.round(n).toLocaleString('pt-BR')} />
            </p>
            lidos do cache
          </div>
          <div className="px-2 py-2.5">
            <p className="font-mono text-[15px] text-fg tabular-nums">
              <CountUp
                to={0.0041}
                format={(n) =>
                  'US$ ' +
                  n.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
                }
              />
            </p>
            custo desta resposta
          </div>
        </div>
      </div>
    </div>
  )
}
