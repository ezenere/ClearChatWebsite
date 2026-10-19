// Conversas: lista decifrada (título, atualização, tamanho), ver e apagar.
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { MessagesSquare, RefreshCw, Search as SearchIcon, Trash2 } from 'lucide-react'
import { isApiError } from '../../api'
import { toast } from '../../components/toast'
import { Alert, Button, ConfirmDialog, EmptyState, Input, Spinner } from '../../components/ui'
import { type ChatSummary, listChats } from '../../data/chats'
import { errorMessage } from '../../lib/errors'
import { formatBytes, formatDateTime, relativeTime } from '../../lib/format'
import { useAsync } from '../../lib/useAsync'
import { useLiveRefresh } from '../../state/live'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

export default function Chats() {
  const repo = useSession((s) => s.vault!.repo)
  const { data, error, loading, reload } = useAsync(() => listChats(repo), [repo])
  const [q, setQ] = useState('')
  const [toDelete, setToDelete] = useState<ChatSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  useLiveRefresh(['chat', 'session', 'message'], () => void reload(true))

  const chats = useMemo(() => {
    const list = data?.chats ?? []
    const term = q.trim().toLowerCase()
    return term ? list.filter((c) => c.title.toLowerCase().includes(term)) : list
  }, [data, q])
  const total = useMemo(() => (data?.chats ?? []).reduce((n, c) => n + c.size, 0), [data])

  const remove = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await repo.remove(toDelete.entry.change)
      toast('Conversa apagada em todos os dispositivos.')
      setToDelete(null)
      await reload(true)
    } catch (e) {
      toast(
        isApiError(e, 'chat_busy')
          ? 'Esta conversa está rodando em um dispositivo agora. Tente quando o turno terminar.'
          : errorMessage(e),
        'error'
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Conversas"
        description="Decifradas aqui no navegador. Apagar uma conversa a remove de todos os seus dispositivos."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="size-4" />}
            onClick={() => void reload()}
            aria-label="Recarregar"
          >
            <span className="hidden sm:inline">Recarregar</span>
          </Button>
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {data?.broken.length ? (
        <Alert tone="warning" className="mb-4">
          {data.broken.length} conversa(s) não puderam ser decifradas ({data.broken[0].error}).
        </Alert>
      ) : null}
      {loading && !data ? (
        <div className="py-16 text-center">
          <Spinner label="Decifrando conversas…" />
        </div>
      ) : !data?.chats.length ? (
        <EmptyState icon={<MessagesSquare className="size-5" />} title="Nenhuma conversa ainda">
          As conversas aparecem aqui quando o app sincroniza com esta conta.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative max-w-xs flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrar por título"
                className="pl-9"
                aria-label="Filtrar conversas"
              />
            </div>
            <span className="text-[13px] text-subtle">
              {data.chats.length} conversa{data.chats.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(total)} cifrados
            </span>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {chats.map((c) => (
              <li
                key={c.id}
                className="group flex items-center gap-3 px-4 py-3 hover:bg-hover/60 sm:px-5"
              >
                <Link
                  to={`/app/chats/${encodeURIComponent(c.id)}`}
                  className="min-w-0 flex-1 py-0.5"
                >
                  <p className="truncate text-[15px] font-medium text-fg">{c.title}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-subtle">
                    <span title={formatDateTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</span>
                    <span>
                      {c.messages} mensage{c.messages === 1 ? 'm' : 'ns'}
                    </span>
                    <span>{formatBytes(c.size)}</span>
                  </p>
                </Link>
                <button
                  onClick={() => setToDelete(c)}
                  className="rounded-lg p-2 text-subtle opacity-100 transition hover:bg-danger/10 hover:text-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                  aria-label={`Apagar ${c.title}`}
                  title="Apagar"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
            {!chats.length && (
              <li className="px-5 py-8 text-center text-sm text-subtle">Nada encontrado.</li>
            )}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        busy={deleting}
        danger
        title="Apagar conversa?"
        confirmLabel="Apagar"
      >
        <p>
          <b className="text-fg">{toDelete?.title}</b> será apagada com todas as sessões e
          mensagens, em todos os seus dispositivos. Não dá para desfazer.
        </p>
      </ConfirmDialog>
    </>
  )
}
