// Painel (tudo decifrado no navegador): barra lateral no desktop, gaveta no celular.
import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import {
  Lock,
  LogOut,
  Menu,
  MessagesSquare,
  MonitorSmartphone,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  UserRound,
  X
} from 'lucide-react'
import { Wordmark } from '../../components/Logo'
import { cx } from '../../components/ui'
import { useSession } from '../../state/session'

const NAV = [
  { to: '/app', label: 'Conversas', icon: MessagesSquare, end: true },
  { to: '/app/providers', label: 'Provedores', icon: Sparkles },
  { to: '/app/search', label: 'Pesquisa na web', icon: Search },
  { to: '/app/devices', label: 'Dispositivos', icon: MonitorSmartphone },
  { to: '/app/security', label: 'Segurança', icon: ShieldCheck },
  { to: '/app/account', label: 'Conta', icon: UserRound },
  { to: '/app/instance', label: 'Instância', icon: Server }
]

function liveLabel(s: string, stopCode: number | null): { label: string; title: string } {
  switch (s) {
    case 'online':
      return { label: 'Ao vivo', title: 'Recebendo atualizações ao vivo' }
    case 'offline':
      return {
        label: 'Reconectando',
        title: 'Sem conexão ao vivo com o servidor; tentando de novo automaticamente…'
      }
    case 'stopped':
      if (stopCode === 4409)
        return {
          label: 'Em outra aba',
          title:
            'As atualizações ao vivo foram assumidas por outra aba. Clique para trazê-las para cá.'
        }
      if (stopCode === 4001)
        return {
          label: 'Desatualizado',
          title: 'Versão do site incompatível. Recarregue a página.'
        }
      return {
        label: 'Desconectado',
        title: 'Atualizações ao vivo paradas. Clique para reconectar.'
      }
    default:
      return { label: 'Conectando', title: 'Conectando ao servidor…' }
  }
}

function LiveDot() {
  const s = useSession((st) => st.socket)
  const stopCode = useSession((st) => st.socketStopCode)
  const reconnect = useSession((st) => st.reconnectSocket)
  const online = s === 'online'
  const stopped = s === 'stopped'
  const { label, title } = liveLabel(s, stopCode)
  const content = (
    <>
      <span
        className={cx(
          'size-1.5 rounded-full',
          online ? 'bg-success' : stopped ? 'bg-subtle' : 'animate-pulse-soft bg-warning'
        )}
      />
      {label}
    </>
  )
  const cls = 'inline-flex items-center gap-1.5 text-[11.5px] text-subtle'
  if (stopped && stopCode !== 4001)
    return (
      <button
        type="button"
        className={cx(cls, 'rounded hover:text-fg')}
        title={title}
        data-testid="live-status"
        data-status={s}
        onClick={reconnect}
      >
        {content}
      </button>
    )
  return (
    <span className={cls} title={title} data-testid="live-status" data-status={s} role="status">
      {content}
    </span>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, info, lock, logout } = useSession()
  const navigate = useNavigate()
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-5 pb-4">
        <Link to="/app" onClick={onNavigate} className="rounded-lg">
          <Wordmark name={info?.name ?? 'ClearChat'} />
        </Link>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5" aria-label="Painel">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors',
                isActive
                  ? 'bg-accent-soft font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )
            }
          >
            {({ isActive }) => (
              <>
                <n.icon className={cx('size-4', isActive ? 'text-accent-strong' : 'text-subtle')} />
                {n.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="m-2.5 rounded-xl border border-border bg-bg/50 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium" title={user?.name}>
              {user?.name}
            </p>
            <p className="truncate text-[12px] text-subtle" title={user?.email}>
              {user?.email}
            </p>
          </div>
          <LiveDot />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <button
            onClick={() => {
              lock('manual')
              navigate('/unlock')
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg"
          >
            <Lock className="size-3.5" /> Bloquear
          </button>
          <button
            onClick={() => void logout().then(() => navigate('/login'))}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg"
          >
            <LogOut className="size-3.5" /> Sair
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PanelLayout() {
  const [open, setOpen] = useState(false)
  const info = useSession((s) => s.info)
  useEffect(() => {
    document.title = `Painel · ${info?.name ?? 'ClearChat'}`
    return () => {
      document.title = info?.name ?? 'ClearChat'
    }
  }, [info?.name])
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-surface/60 lg:block">
        <Sidebar />
      </aside>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-bg/85 px-4 py-3 backdrop-blur lg:hidden">
        <Link to="/app">
          <Wordmark name={info?.name ?? 'ClearChat'} />
        </Link>
        <div className="flex items-center gap-3">
          <LiveDot />
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg border border-border p-2 text-muted hover:text-fg"
            aria-label="Abrir menu"
          >
            <Menu className="size-4" />
          </button>
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 animate-fade-in bg-black/60"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-[min(20rem,86vw)] animate-slide-up border-l border-border bg-surface">
            <button
              onClick={() => setOpen(false)}
              className="absolute top-5 right-4 rounded-md p-1 text-subtle hover:text-fg"
              aria-label="Fechar menu"
            >
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
