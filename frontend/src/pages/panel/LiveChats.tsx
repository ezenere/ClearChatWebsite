// Chats só ao vivo de outros dispositivos (SYNC_PROTOCOL.md §23.10): em 1.8.0 o site mostra só a
// contagem e uma lista simples (título, host, status). Não abre, não lê histórico, não manda comandos.
import { useEffect, useMemo, useState } from 'react'
import { Radio } from 'lucide-react'
import { Badge } from '../../components/ui'
import {
  infoKey,
  type LiveChatInfo,
  liveStatus,
  type LiveStatusLabel,
  openLiveChat
} from '../../data/liveChats'
import { useLiveChats } from '../../state/liveChats'
import { useSession } from '../../state/session'

const TONE: Record<LiveStatusLabel, 'accent' | 'warning' | 'neutral' | 'danger'> = {
  rodando: 'accent',
  'aguardando você': 'warning',
  ocioso: 'neutral',
  reconectando: 'danger'
}

export default function LiveChats() {
  const chats = useLiveChats((s) => s.chats)
  const supported = useLiveChats((s) => s.supported)
  const stream = useSession((s) => s.vault?.sk.stream ?? null)
  const userId = useSession((s) => s.user?.id ?? null)
  // plaintext decifrado só em memória, nesta tela (some ao bloquear: o painel desmonta)
  const [infos, setInfos] = useState<Record<string, LiveChatInfo | null>>({})

  useEffect(() => {
    if (!stream || !userId) return
    const todo = Object.values(chats)
      .map((e) => e.chat)
      .filter((c) => !(infoKey(c) in infos))
    if (!todo.length) return
    let alive = true
    void Promise.all(
      todo.map(async (c) => [infoKey(c), await openLiveChat(stream, userId, c)] as const)
    ).then((got) => {
      if (alive) setInfos((prev) => ({ ...prev, ...Object.fromEntries(got) }))
    })
    return () => {
      alive = false
    }
  }, [chats, infos, stream, userId])

  const rows = useMemo(
    () =>
      Object.values(chats)
        .map((e) => ({ e, info: infos[infoKey(e.chat)] }))
        // undefined = decifrando; null = não decifrou (o item não aparece, §23.4)
        .filter((r): r is { e: (typeof r)['e']; info: LiveChatInfo } => !!r.info)
        .sort((a, b) => b.info.updatedAt - a.info.updatedAt),
    [chats, infos]
  )

  if (!supported && !rows.length) return null
  return (
    <section className="mb-6" aria-label="Chats ao vivo">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-fg">
          <Radio className="size-4 text-accent" /> Só ao vivo em outros dispositivos
        </h2>
        <span className="text-[13px] text-subtle" data-testid="live-count">
          {rows.length === 0
            ? 'nenhum agora'
            : `${rows.length} chat${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="mb-3 text-[12.5px] text-subtle">
        Chats só ao vivo ficam guardados só no dispositivo que os executa e aparecem aqui enquanto o
        app dele estiver aberto e conectado. Para abrir e conversar, use o app.
      </p>
      {rows.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {rows.map(({ e, info }) => {
            const st = liveStatus(e, info)
            return (
              <li key={e.chat.chat_id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-fg">{info.title}</p>
                  <p className="mt-0.5 truncate text-[12.5px] text-subtle">
                    Ao vivo em {e.chat.host.name || 'outro dispositivo'}
                  </p>
                </div>
                <Badge tone={TONE[st]}>{st}</Badge>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
