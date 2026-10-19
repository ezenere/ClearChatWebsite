// Conta: nome, uso e cotas; zona de perigo (zerar criptografia, apagar conta) com código por e-mail.
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { LogOut, Pencil, TriangleAlert } from 'lucide-react'
import { api } from '../../api'
import { CodeInput } from '../../components/CodeInput'
import { toast } from '../../components/toast'
import { Alert, Button, Card, Field, Input, Modal, Spinner } from '../../components/ui'
import { errorMessage } from '../../lib/errors'
import { formatBytes, formatDate } from '../../lib/format'
import { useAsync } from '../../lib/useAsync'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

type Danger = 'delete_account' | 'reset_keys'

function Usage({
  label,
  used,
  limit,
  bytes
}: {
  label: string
  used: number
  limit: number | null
  bytes?: boolean
}) {
  const fmt = (n: number) => (bytes ? formatBytes(n) : n.toLocaleString('pt-BR'))
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0
  return (
    <div className="rounded-xl border border-border bg-bg/40 p-3.5">
      <p className="text-[12px] text-subtle">{label}</p>
      <p className="mt-1 text-[17px] font-semibold tabular-nums">{fmt(used)}</p>
      <p className="text-[12px] text-faint">{limit == null ? 'sem limite' : `de ${fmt(limit)}`}</p>
      {limit != null && (
        <div className="mt-2 h-1 rounded-full bg-active">
          <div className="h-1 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function DangerFlow({ kind, onClose }: { kind: Danger; onClose: () => void }) {
  const { user, endSession } = useSession()
  const navigate = useNavigate()
  const [stage, setStage] = useState<'confirm' | 'code'>('confirm')
  const [ack, setAck] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDelete = kind === 'delete_account'
  const expected = isDelete ? (user?.email ?? '') : 'APAGAR'

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await api().reauthRequest(kind)
      setStage('code')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      if (isDelete) {
        await api().deleteAccount(code)
        endSession('Sua conta foi apagada.')
        navigate('/login', { replace: true })
      } else {
        await api().resetKeys(code)
        useSession.setState({ keys: null, vault: null, phase: 'needs_setup' })
        navigate('/setup', { replace: true })
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={isDelete ? 'Apagar conta' : 'Zerar criptografia'}
    >
      <div className="space-y-4">
        <Alert
          tone="danger"
          title={isDelete ? 'Tudo será apagado na hora' : 'Todos os dados da nuvem serão apagados'}
        >
          {isDelete
            ? 'Conta, dispositivos, conversas, provedores, memórias e anexos sincronizados são apagados do servidor imediatamente. Os dados locais dos seus dispositivos continuam neles.'
            : 'Use só se perdeu a senha e a chave de recuperação. Registros e anexos são apagados do servidor; você define uma senha nova e os dispositivos reenviam os dados que têm.'}
        </Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        {stage === 'confirm' ? (
          <>
            <Field
              label={
                isDelete
                  ? `Digite seu e-mail (${expected}) para confirmar`
                  : 'Digite "APAGAR" para confirmar'
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={ack}
                  onChange={(e) => setAck(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Button
              variant="danger"
              className="w-full"
              loading={busy}
              disabled={ack.trim().toLowerCase() !== expected.toLowerCase()}
              onClick={send}
            >
              Enviar código de confirmação
            </Button>
          </>
        ) : (
          <>
            <Field label={`Código enviado para ${user?.email}`}>
              {(id) => (
                <CodeInput id={id} value={code} onChange={setCode} autoFocus disabled={busy} />
              )}
            </Field>
            <Button
              variant="danger"
              className="w-full"
              loading={busy}
              disabled={code.length !== 6}
              onClick={confirm}
            >
              {isDelete ? 'Apagar minha conta' : 'Apagar dados e recomeçar'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}

export default function AccountPage() {
  const { logout } = useSession()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useAsync(() => api().account(), [])
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [danger, setDanger] = useState<Danger | null>(null)

  const saveName = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const acc = await api().updateAccount(name.trim())
      useSession.setState((s) => ({ user: s.user ? { ...s.user, name: acc.name } : s.user }))
      toast('Nome atualizado.')
      setEditing(false)
      await reload(true)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Conta"
        actions={
          <Button
            icon={<LogOut className="size-4" />}
            onClick={() => void logout().then(() => navigate('/login'))}
          >
            Sair
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
      ) : data ? (
        <div className="space-y-5">
          <Card title="Perfil">
            <dl className="grid gap-4 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-subtle">Nome</dt>
              <dd>
                {editing ? (
                  <div className="flex max-w-sm gap-2">
                    <Input
                      value={name}
                      maxLength={64}
                      autoFocus
                      onChange={(e) => setName(e.target.value)}
                      aria-label="Nome"
                    />
                    <Button variant="primary" loading={busy} onClick={saveName}>
                      Salvar
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    {data.name}
                    <button
                      onClick={() => {
                        setName(data.name)
                        setEditing(true)
                      }}
                      className="text-subtle hover:text-fg"
                      aria-label="Editar nome"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </span>
                )}
              </dd>
              <dt className="text-subtle">E-mail</dt>
              <dd className="break-all">{data.email}</dd>
              <dt className="text-subtle">Conta criada</dt>
              <dd>{formatDate(data.created_at)}</dd>
            </dl>
          </Card>
          <Card title="Uso" description="Tamanhos dos dados cifrados guardados no servidor.">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Usage label="Registros" used={data.usage.records} limit={data.quotas.records} />
              <Usage
                label="Dados"
                used={data.usage.record_bytes}
                limit={data.quotas.record_bytes}
                bytes
              />
              <Usage
                label="Anexos"
                used={data.usage.blob_bytes}
                limit={data.quotas.blob_bytes}
                bytes
              />
              <Usage label="Dispositivos" used={data.usage.devices} limit={data.quotas.devices} />
            </div>
          </Card>
          <section className="rounded-2xl border border-danger/25 bg-danger/[0.03]">
            <header className="flex items-center gap-2 border-b border-danger/20 px-5 py-4">
              <TriangleAlert className="size-4 text-danger" />
              <h2 className="text-[15px] font-semibold">Zona de perigo</h2>
            </header>
            <div className="divide-y divide-danger/15">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="max-w-xl">
                  <p className="text-sm font-medium">Zerar criptografia</p>
                  <p className="text-[13px] text-subtle">
                    Perdeu a senha e a chave de recuperação? Apaga os dados da nuvem e recomeça com
                    uma senha nova.
                  </p>
                </div>
                <Button variant="danger-soft" onClick={() => setDanger('reset_keys')}>
                  Zerar criptografia
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="max-w-xl">
                  <p className="text-sm font-medium">Apagar conta</p>
                  <p className="text-[13px] text-subtle">
                    Remove a conta e tudo o que está no servidor, na hora.
                  </p>
                </div>
                <Button variant="danger-soft" onClick={() => setDanger('delete_account')}>
                  Apagar conta
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {danger && <DangerFlow kind={danger} onClose={() => setDanger(null)} />}
    </>
  )
}
