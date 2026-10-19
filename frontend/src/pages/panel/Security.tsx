// Segurança: trocar a senha de criptografia (nova wrap da MESMA DEK + key_proof) e gerar nova chave
// de recuperação (§5.5, §6.5).
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { api } from '../../api'
import { NewPasswordFields, useNewPassword } from '../../components/NewPasswordFields'
import { RecoveryKeyPanel } from '../../components/RecoveryKeyPanel'
import { toast } from '../../components/toast'
import { Alert, Button, Card, Field, Modal, PasswordInput } from '../../components/ui'
import {
  ARGON2_DEFAULT,
  AuthError,
  passwordChangeBody,
  recoveryChangeBody,
  unlockWithPassword,
  bytesEqual
} from '../../crypto'
import { errorMessage } from '../../lib/errors'
import { kekInWorker } from '../../lib/kdf'
import { useSession } from '../../state/session'
import { PageHeader } from './PanelLayout'

function ChangePassword() {
  const { user, keys, vault, refreshKeys } = useSession()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { ok } = useNewPassword(pw, confirm, user?.email ?? '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!ok || !current || !user || !keys || !vault) return
    setBusy(true)
    setError(null)
    try {
      // confirma a senha atual (protege uma aba desbloqueada deixada aberta)
      let dek
      try {
        dek = await unlockWithPassword(user.id, keys, current, kekInWorker)
      } catch (err) {
        if (err instanceof AuthError)
          throw new Error('A senha atual está incorreta.', { cause: err })
        throw err
      }
      if (!bytesEqual(dek, vault.dek)) throw new Error('As chaves mudaram. Desbloqueie de novo.')
      dek.fill(0)
      const body = await passwordChangeBody(user.id, vault.dek, pw, ARGON2_DEFAULT, kekInWorker)
      await api().changePassword(body)
      await refreshKeys()
      setCurrent('')
      setPw('')
      setConfirm('')
      setTried(false)
      toast('Senha de criptografia trocada. Os outros dispositivos continuam funcionando.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Senha de criptografia"
      description="Trocar a senha não re-cifra seus dados: só a forma de abrir a chave deles. A senha antiga deixa de funcionar em todos os dispositivos."
    >
      <form onSubmit={submit} className="max-w-md space-y-4" data-testid="change-password">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Senha atual">
          {(id) => (
            <PasswordInput
              id={id}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          )}
        </Field>
        <NewPasswordFields
          pw={pw}
          confirm={confirm}
          setPw={setPw}
          setConfirm={setConfirm}
          email={user?.email ?? ''}
          label="Nova senha"
          disabled={busy}
          showErrors={tried}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!ok || !current}>
          Trocar senha
        </Button>
      </form>
    </Card>
  )
}

function NewRecoveryKey() {
  const { user, vault, info, refreshKeys } = useSession()
  const [pending, setPending] = useState<Awaited<ReturnType<typeof recoveryChangeBody>> | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    if (!user || !vault) return
    setBusy(true)
    setError(null)
    try {
      setPending(await recoveryChangeBody(user.id, vault.dek))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await api().changeRecovery(pending.body)
      await refreshKeys()
      setPending(null)
      toast('Nova chave de recuperação ativada. A anterior não funciona mais.')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Chave de recuperação"
      description="Perdeu a chave ou acha que ela foi exposta? Gere outra. A antiga só deixa de valer quando você confirmar que guardou a nova."
    >
      {error && !pending && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <Button icon={<KeyRound className="size-4" />} onClick={generate} loading={busy && !pending}>
        Gerar nova chave de recuperação
      </Button>
      <Modal
        open={!!pending}
        onClose={() => !busy && setPending(null)}
        title="Nova chave de recuperação"
        wide
      >
        {pending && (
          <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <RecoveryKeyPanel
              recoveryKey={pending.recoveryKey}
              email={user?.email ?? ''}
              instanceName={info?.name ?? 'ClearChat'}
              confirmLabel="Guardei — ativar a nova chave"
              busy={busy}
              onConfirmed={activate}
            />
          </div>
        )}
      </Modal>
    </Card>
  )
}

export default function Security() {
  const lock = useSession((s) => s.lock)
  const navigate = useNavigate()
  return (
    <>
      <PageHeader
        title="Segurança"
        description="Suas chaves só existem decifradas neste navegador, enquanto ele estiver desbloqueado."
      />
      <div className="space-y-5">
        <ChangePassword />
        <NewRecoveryKey />
        <Card
          title="Bloqueio"
          description="O site bloqueia sozinho após 15 minutos sem uso, ao recarregar a página ou fechar a aba."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button
              icon={<Lock className="size-4" />}
              onClick={() => {
                lock('manual')
                navigate('/unlock')
              }}
            >
              Bloquear agora
            </Button>
            <span className="inline-flex items-center gap-1.5 text-[13px] text-subtle">
              <ShieldCheck className="size-4 text-success" /> Nada é guardado no navegador (nem
              localStorage, nem sessionStorage).
            </span>
          </div>
        </Card>
      </div>
    </>
  )
}
