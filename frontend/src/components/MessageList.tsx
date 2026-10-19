// Renderização somente leitura das mensagens de uma sessão (ApiMessage + MessageMeta do app).
import { useState } from 'react'
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Paperclip,
  Scissors,
  Terminal,
  Wrench
} from 'lucide-react'
import type { SiblingInfo } from '../data/branches'
import type { Entry } from '../data/repo'
import type { ContentPart, MessagePlain, ToolCall } from '../data/schemas'
import { formatDateTime } from '../lib/format'
import { Markdown } from './Markdown'
import { cx } from './ui'

const MAX_TOOL_OUTPUT = 6000

function partsText(content: string | ContentPart[] | null | undefined): {
  text: string
  attachments: string[]
} {
  if (content == null) return { text: '', attachments: [] }
  if (typeof content === 'string') return { text: content, attachments: [] }
  const texts: string[] = []
  const attachments: string[] = []
  for (const p of content) {
    const att = (p as { _attachment?: { name?: string } })._attachment
    if (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string') {
      if (att) attachments.push(att.name ?? 'arquivo de texto')
      else texts.push((p as { text: string }).text)
    } else if (p.type === 'image_url') attachments.push(att?.name ?? 'imagem')
    else if (p.type === 'file')
      attachments.push(
        att?.name ?? (p as { file?: { filename?: string } }).file?.filename ?? 'arquivo'
      )
    else if (p.type === 'input_audio') attachments.push(att?.name ?? 'áudio')
  }
  return { text: texts.join('\n\n'), attachments }
}

function Collapsible({
  icon,
  title,
  meta,
  children,
  defaultOpen = false,
  tone
}: {
  icon: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  tone?: 'danger'
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className={cx(
        'rounded-xl border bg-surface',
        tone === 'danger' ? 'border-danger/30' : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]"
        aria-expanded={open}
      >
        <ChevronRight
          className={cx('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 text-subtle">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{title}</span>
        {meta && (
          <span className="shrink-0 truncate font-mono text-[11.5px] text-subtle">{meta}</span>
        )}
      </button>
      {open && <div className="border-t border-border px-3 py-3">{children}</div>}
    </div>
  )
}

function Pre({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > MAX_TOOL_OUTPUT
  return (
    <div>
      <pre className="max-h-[28rem] overflow-auto rounded-lg bg-bg/70 p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">
        {long && !all ? text.slice(0, MAX_TOOL_OUTPUT) + '\n…' : text}
      </pre>
      {long && (
        <button
          onClick={() => setAll((a) => !a)}
          className="mt-1.5 text-[12px] text-accent-strong hover:underline"
        >
          {all
            ? 'Mostrar menos'
            : `Mostrar tudo (${text.length.toLocaleString('pt-BR')} caracteres)`}
        </button>
      )}
    </div>
  )
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function argSummary(raw: string): string {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const v = o.command ?? o.path ?? o.query ?? o.task ?? o.url ?? Object.values(o)[0]
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

function Attachments({ names }: { names: string[] }) {
  if (!names.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {names.map((n, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg/60 px-2 py-0.5 text-[12px] text-muted"
          title="Anexos ficam no app (o site não baixa anexos)"
        >
          <Paperclip className="size-3" /> {n}
        </span>
      ))}
    </div>
  )
}

/** Controles de versão (‹ i/n ›) de um caminho: irmãos de cada mensagem e troca. */
export interface BranchControls {
  info: (id: string) => SiblingInfo | null
  onSelect: (parentKey: string, childId: string) => void
}

/** Seletor de versão — sempre visível (sinaliza que existem outras versões); ←/→ quando focado. */
function BranchSwitcher({
  info,
  onSelect
}: {
  info: SiblingInfo
  onSelect: BranchControls['onSelect']
}) {
  const go = (id: string | null) => {
    if (id) onSelect(info.parentKey, id)
  }
  const btn =
    'grid size-6 place-items-center rounded-md transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35'
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`Versão ${info.index + 1} de ${info.count}`}
      data-testid="branch-switcher"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          go(info.prevId)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          go(info.nextId)
        }
      }}
      className="inline-flex items-center gap-0.5 rounded-lg text-[12px] text-subtle select-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
    >
      <button
        type="button"
        className={btn}
        title="Versão anterior"
        aria-label="Versão anterior"
        disabled={!info.prevId}
        onClick={() => go(info.prevId)}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="min-w-[2.25rem] text-center font-mono tabular-nums">
        {info.index + 1}/{info.count}
      </span>
      <button
        type="button"
        className={btn}
        title="Próxima versão"
        aria-label="Próxima versão"
        disabled={!info.nextId}
        onClick={() => go(info.nextId)}
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * `messages` = o caminho a mostrar (já resolvido). Com `branches`, as mensagens cuja mãe tem mais de um
 * filho ganham o seletor de versão: no balão do usuário, no rodapé da resposta que diverge, e numa
 * linha acima das outras (erro, sintética…).
 */
export function MessageList({
  messages,
  branches
}: {
  messages: Entry<MessagePlain>[]
  branches?: BranchControls
}) {
  // resultados de tools vão dentro do cartão da chamada correspondente
  const results = new Map<string, string>()
  const consumed = new Set<string>()
  const callIds = new Set<string>()
  for (const { plain } of messages) {
    const m = plain.message
    if (m?.role === 'assistant') for (const c of m.tool_calls ?? []) callIds.add(c.id)
  }
  for (const { plain, change } of messages) {
    const m = plain.message
    if (m?.role === 'tool' && callIds.has(m.tool_call_id)) {
      results.set(m.tool_call_id, partsText(m.content).text)
      consumed.add(change.id)
    }
  }

  return (
    <div className="space-y-5">
      {messages.map(({ plain, change }) => {
        const sib = branches?.info(change.id)
        const switcher =
          branches && sib && sib.count > 1 ? (
            <BranchSwitcher info={sib} onSelect={branches.onSelect} />
          ) : null
        // na bifurcação a chave é a da mãe: trocar de versão reaproveita o elemento (o foco do
        // seletor continua nele, então ←/→ seguem funcionando)
        const key = switcher ? `fork:${sib!.parentKey}` : change.id
        const m = plain.message
        const meta = plain.meta ?? {}
        const withSwitcherAbove = (node: React.ReactNode) =>
          switcher ? (
            <div key={key} className="space-y-1.5">
              <div className="flex">{switcher}</div>
              {node}
            </div>
          ) : (
            <div key={key}>{node}</div>
          )
        if (consumed.has(change.id)) return switcher ? withSwitcherAbove(null) : null
        if (!m) return null
        if (meta.kind === 'compaction')
          return withSwitcherAbove(
            <Collapsible
              icon={<Scissors className="size-3.5" />}
              title="Conversa compactada"
              meta="resumo"
            >
              <Markdown text={partsText(m.content as string | ContentPart[]).text} />
            </Collapsible>
          )
        if (meta.kind === 'error')
          return withSwitcherAbove(
            <div className="flex gap-2.5 rounded-xl border border-danger/30 bg-danger/[0.06] px-4 py-3 text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 text-muted">
                {partsText((m as { content: string | ContentPart[] }).content).text || 'Erro'}
              </div>
            </div>
          )
        if (m.role === 'system')
          return withSwitcherAbove(
            <Collapsible icon={<Terminal className="size-3.5" />} title="Prompt de sistema">
              <Pre text={partsText(m.content).text} />
            </Collapsible>
          )
        if (m.role === 'user') {
          const { text, attachments } = partsText(m.content)
          const synthetic = meta.synthetic
          return (
            <div key={key} className="flex flex-col items-end gap-1">
              <div
                className={cx(
                  'max-w-[88%] rounded-2xl rounded-br-md border px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[78%]',
                  synthetic
                    ? 'border-dashed border-border bg-transparent text-muted'
                    : 'border-border bg-elevated'
                )}
                title={formatDateTime(plain.createdAt)}
              >
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
                <Attachments names={attachments} />
              </div>
              {switcher}
            </div>
          )
        }
        if (m.role === 'assistant') {
          const usage = meta.usage
          return (
            <div key={key} className="space-y-2.5">
              {m.reasoning && (
                <Collapsible icon={<Brain className="size-3.5" />} title="Raciocínio">
                  <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted">
                    {m.reasoning}
                  </p>
                </Collapsible>
              )}
              {m.content && <Markdown text={m.content} />}
              {(m.tool_calls ?? []).map((c: ToolCall) => (
                <Collapsible
                  key={c.id}
                  icon={<Wrench className="size-3.5" />}
                  title={c.function?.name ?? 'ferramenta'}
                  meta={argSummary(c.function?.arguments ?? '')}
                >
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1 text-[12px] font-medium text-subtle">Argumentos</p>
                      <Pre text={prettyArgs(c.function?.arguments ?? '')} />
                    </div>
                    <div>
                      <p className="mb-1 text-[12px] font-medium text-subtle">Resultado</p>
                      {results.has(c.id) ? (
                        <Pre text={results.get(c.id) || '(vazio)'} />
                      ) : (
                        <p className="text-[13px] text-subtle">Sem resultado registrado.</p>
                      )}
                    </div>
                  </div>
                </Collapsible>
              ))}
              {(switcher || meta.model || usage) && (
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {switcher}
                  {(meta.model || usage) && (
                    <p className="font-mono text-[11.5px] text-subtle">
                      {[
                        meta.model,
                        usage?.promptTokens != null &&
                          `${(usage.promptTokens / 1000).toFixed(1)}k in`,
                        usage?.completionTokens != null && `${usage.completionTokens} out`,
                        formatDateTime(plain.createdAt)
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        }
        // tool sem chamada correspondente
        return withSwitcherAbove(
          <Collapsible icon={<Wrench className="size-3.5" />} title="Resultado de ferramenta">
            <Pre text={partsText(m.content).text} />
          </Collapsible>
        )
      })}
    </div>
  )
}
