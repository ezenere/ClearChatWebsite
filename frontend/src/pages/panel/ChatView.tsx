// Conversa (somente leitura): sessão principal + subagentes. Mostra o caminho ativo da árvore de versões
// (§4.3.8) escolhido no app (`session.branchSel`); trocar de versão aqui é só na tela (§4.3.7).
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Bot, ChevronRight, GitBranch, Info, Trash2 } from 'lucide-react'
import { isApiError } from '../../api'
import { MessageList } from '../../components/MessageList'
import { toast } from '../../components/toast'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Spinner, cx } from '../../components/ui'
import { activePath, buildTree, siblingInfo, type BranchSel } from '../../data/branches'
import { loadChat, messageNode, type SessionView } from '../../data/chats'
import { errorMessage } from '../../lib/errors'
import { formatDateTime, relativeTime } from '../../lib/format'
import { useAsync } from '../../lib/useAsync'
import { useLiveRefresh } from '../../state/live'
import { useSession } from '../../state/session'

function Subagent({ view }: { view: SessionView }) {
  const [open, setOpen] = useState(false)
  const s = view.entry.plain
  // subsessões são lineares; o caminho ativo só protege contra versões soltas
  const path = useMemo(
    () => activePath(buildTree(view.messages, messageNode), view.branchSel),
    [view]
  )
  return (
    <div className="rounded-2xl border border-border bg-surface/60">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cx('size-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
        />
        <Bot className="size-4 shrink-0 text-accent-strong" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{s.title || 'Subagente'}</p>
          {s.task && <p className="truncate text-[12.5px] text-subtle">{s.task}</p>}
        </div>
        <span className="hidden shrink-0 font-mono text-[11.5px] text-subtle sm:inline">
          {s.model}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-4">
          {path.length ? (
            <MessageList messages={path} />
          ) : (
            <p className="text-sm text-subtle">Sem mensagens.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function ChatView() {
  const { chatId = '' } = useParams()
  const repo = useSession((s) => s.vault!.repo)
  const navigate = useNavigate()
  const { data, error, loading, reload } = useAsync(() => loadChat(repo, chatId), [repo, chatId])
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useLiveRefresh(['chat', 'session', 'message'], () => void reload(true), { scope: chatId })

  // Versões: o padrão é a do app (`branchSel` sincronizado). Trocar aqui só muda a tela — `overrides`
  // em estado local, descartado quando o `branchSel` sincronizado ou a conversa mudam.
  const main = data?.main ?? null
  const syncKey = `${chatId}|${main?.entry.change.id ?? ''}|${JSON.stringify(main?.branchSel ?? {})}`
  const [local, setLocal] = useState<{ key: string; sel: BranchSel }>({ key: '', sel: {} })
  const overrides = local.key === syncKey ? local.sel : null
  const branches = useMemo(() => {
    if (!main) return null
    const tree = buildTree(main.messages, messageNode)
    const appPath = activePath(tree, main.branchSel)
    const path = overrides ? activePath(tree, { ...main.branchSel, ...overrides }) : appPath
    const differs =
      path.length !== appPath.length || path.some((m, i) => m.change.id !== appPath[i].change.id)
    return { tree, path, differs }
  }, [main, overrides])

  const remove = async () => {
    if (!data) return
    setDeleting(true)
    try {
      await repo.remove(data.chat.change)
      toast('Conversa apagada em todos os dispositivos.')
      navigate('/app', { replace: true })
    } catch (e) {
      toast(
        isApiError(e, 'chat_busy')
          ? 'Esta conversa está rodando em um dispositivo agora. Tente quando o turno terminar.'
          : errorMessage(e),
        'error'
      )
      setDeleting(false)
    }
  }

  const back = (
    <Link
      to="/app"
      className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
    >
      <ArrowLeft className="size-3.5" /> Conversas
    </Link>
  )

  if (loading && !data)
    return (
      <>
        {back}
        <div className="py-16 text-center">
          <Spinner label="Decifrando a conversa…" />
        </div>
      </>
    )
  if (error)
    return (
      <>
        {back}
        <Alert tone="danger">{error}</Alert>
      </>
    )
  if (!data)
    return (
      <>
        {back}
        <EmptyState icon={<Info className="size-5" />} title="Conversa não encontrada">
          Ela pode ter sido apagada em outro dispositivo.
        </EmptyState>
      </>
    )

  const chat = data.chat.plain
  const model = (chat.config?.model as string | undefined) ?? data.main?.entry.plain.model
  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">
            {chat.title || 'Sem título'}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-subtle">
            {model && <Badge className="font-mono">{model}</Badge>}
            <span title={formatDateTime(chat.updatedAt)}>
              atualizada {relativeTime(chat.updatedAt)}
            </span>
            <span>· criada {formatDateTime(chat.createdAt)}</span>
            <Badge tone="accent">somente leitura</Badge>
          </div>
        </div>
        <Button
          variant="danger-soft"
          size="sm"
          icon={<Trash2 className="size-4" />}
          onClick={() => setConfirm(true)}
        >
          Apagar
        </Button>
      </div>
      {data.broken > 0 && (
        <Alert tone="warning" className="mb-4">
          {data.broken} registro(s) desta conversa não puderam ser decifrados.
        </Alert>
      )}
      {branches?.differs && (
        <div
          role="status"
          data-testid="branch-banner"
          className="sticky top-16 z-20 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-accent/25 bg-surface/95 px-4 py-2.5 text-[13px] shadow-lg backdrop-blur lg:top-3"
        >
          <GitBranch className="size-4 shrink-0 text-accent-strong" aria-hidden />
          <span className="text-muted">Você está vendo outra versão</span>
          <span className="text-faint" aria-hidden>
            ·
          </span>
          <button
            type="button"
            className="font-medium text-accent-strong hover:underline"
            onClick={() => setLocal({ key: '', sel: {} })}
          >
            Voltar à versão do app
          </button>
        </div>
      )}
      {branches?.path.length ? (
        <MessageList
          messages={branches.path}
          branches={{
            info: (id) => siblingInfo(branches.tree, id),
            onSelect: (parentKey, childId) =>
              setLocal({ key: syncKey, sel: { ...overrides, [parentKey]: childId } })
          }}
        />
      ) : (
        <p className="text-sm text-subtle">Esta conversa não tem mensagens.</p>
      )}
      {data.subagents.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-[13px] font-medium tracking-wide text-subtle uppercase">
            Subagentes ({data.subagents.length})
          </h2>
          <div className="space-y-2">
            {data.subagents.map((v) => (
              <Subagent key={v.entry.change.id} view={v} />
            ))}
          </div>
        </section>
      )}
      <p className="mt-10 text-center text-[12px] text-faint">
        Para continuar esta conversa, abra-a no app — o site só mostra o histórico.
      </p>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={remove}
        busy={deleting}
        danger
        title="Apagar conversa?"
        confirmLabel="Apagar"
      >
        <p>
          <b className="text-fg">{chat.title}</b> será apagada com todas as sessões e mensagens, em
          todos os seus dispositivos. Não dá para desfazer.
        </p>
      </ConfirmDialog>
    </>
  )
}
