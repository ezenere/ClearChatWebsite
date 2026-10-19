// Dispositivos (§6.6): listar, renomear, revogar (o atual = sair).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Globe, Laptop, Monitor, Pencil, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { api } from '../../api'
import type { DeviceInfo } from '../../api/types'
import { toast } from '../../components/toast'
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Spinner,
  cx
} from '../../components/ui'
import { errorMessage } from '../../lib/errors'
import { formatDateTime, relativeTime } from '../../lib/format'
import { useAsync } from '../../lib/useAsync'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

const PLATFORM: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
  ios: 'iOS',
  web: 'Navegador'
}
const CLIENT: Record<string, string> = { desktop: 'App desktop', mobile: 'App mobile', web: 'Site' }

function DeviceIcon({ d }: { d: DeviceInfo }) {
  const Icon =
    d.client === 'web'
      ? Globe
      : d.client === 'mobile'
        ? Smartphone
        : d.platform === 'macos'
          ? Laptop
          : Monitor
  return (
    <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-elevated text-muted">
      <Icon className="size-5" />
      <span
        className={cx(
          'absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface',
          d.online ? 'bg-success' : 'bg-faint'
        )}
        title={d.online ? 'Online' : 'Offline'}
      />
    </div>
  )
}

export default function Devices() {
  const navigate = useNavigate()
  const endSession = useSession((s) => s.endSession)
  const { data, error, loading, reload } = useAsync(() => api().devices(), [])
  const [renaming, setRenaming] = useState<DeviceInfo | null>(null)
  const [name, setName] = useState('')
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setInterval(() => void reload(true), 30_000)
    return () => clearInterval(t)
  }, [reload])

  const rename = async () => {
    if (!renaming || !name.trim()) return
    setBusy(true)
    try {
      await api().renameDevice(renaming.id, name.trim())
      toast('Dispositivo renomeado.')
      setRenaming(null)
      await reload(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!revoking) return
    setBusy(true)
    try {
      await api().revokeDevice(revoking.id)
      if (revoking.current) {
        endSession(null)
        navigate('/login')
        return
      }
      toast('Dispositivo desconectado.')
      setRevoking(null)
      await reload(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const list = [...(data ?? [])].sort(
    (a, b) => Number(b.current) - Number(a.current) || Number(b.online) - Number(a.online)
  )
  return (
    <>
      <PageHeader
        title="Dispositivos"
        description="Cada login cria um dispositivo. Desconectar encerra a sessão dele (ele precisa entrar de novo)."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="size-4" />}
            onClick={() => void reload()}
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
      {loading && !data ? (
        <div className="py-16 text-center">
          <Spinner label="Carregando…" />
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {list.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5"
              data-testid="device-row"
            >
              <DeviceIcon d={d} />
              <div className="min-w-0 flex-1 basis-[calc(100%-3.5rem)] sm:basis-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[15px] font-medium">{d.name}</p>
                  {d.current && <Badge tone="accent">este dispositivo</Badge>}
                  {d.online && !d.current && <Badge tone="success">online</Badge>}
                </div>
                <p className="mt-0.5 text-[12.5px] text-subtle">
                  {CLIENT[d.client] ?? d.client} · {PLATFORM[d.platform] ?? d.platform}
                  {d.app_version ? ` · v${d.app_version}` : ''}
                </p>
                <p className="mt-0.5 text-[12px] text-faint">
                  {d.last_seen_at ? (
                    <span title={formatDateTime(d.last_seen_at)}>
                      visto {relativeTime(d.last_seen_at)}
                    </span>
                  ) : (
                    'nunca visto'
                  )}
                  {d.last_ip ? ` · IP ${d.last_ip}` : ''} · desde {formatDateTime(d.created_at)}
                </p>
              </div>
              <div className="ml-14 flex gap-1 sm:ml-0">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Pencil className="size-3.5" />}
                  onClick={() => {
                    setRenaming(d)
                    setName(d.name)
                  }}
                >
                  Renomear
                </Button>
                <Button
                  size="sm"
                  variant="danger-soft"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => setRevoking(d)}
                >
                  {d.current ? 'Sair' : 'Desconectar'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Alert tone="info" className="mt-5">
        Desconectar não apaga o que o dispositivo já baixou e não troca a chave dos seus dados. Se
        um aparelho foi perdido, desconecte-o e troque a senha de criptografia.
      </Alert>
      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Renomear dispositivo"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancelar
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={rename}>
              Salvar
            </Button>
          </>
        }
      >
        <Field label="Nome">
          {(id) => (
            <Input
              id={id}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
            />
          )}
        </Field>
      </Modal>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        busy={busy}
        danger
        title={revoking?.current ? 'Sair deste dispositivo?' : 'Desconectar dispositivo?'}
        confirmLabel={revoking?.current ? 'Sair' : 'Desconectar'}
      >
        <p>
          <b className="text-fg">{revoking?.name}</b> perde o acesso à conta e precisa entrar de
          novo com código por e-mail. Se ele executava chats, eles ficam sem host até outro
          dispositivo assumir.
        </p>
      </ConfirmDialog>
    </>
  )
}
