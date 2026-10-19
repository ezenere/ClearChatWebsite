// Definir a senha de criptografia (cadastro e /setup): gera DEK + wraps + chave de recuperação no
// navegador, mostra a chave UMA vez e só depois da confirmação envia `POST /keys/setup`.
import { useState, type FormEvent } from 'react'
import { Cpu, EyeOff, KeyRound, LockKeyhole } from 'lucide-react'
import { api, isApiError } from '../api'
import { ARGON2_DEFAULT, type Bytes, createKeyMaterial, type KeysSetupBody } from '../crypto'
import { errorMessage } from '../lib/errors'
import { kekInWorker } from '../lib/kdf'
import { useSession } from '../state/session'
import { NewPasswordFields, useNewPassword } from './NewPasswordFields'
import { RecoveryKeyPanel } from './RecoveryKeyPanel'
import { Alert, Button, Spinner } from './ui'

export type KeySetupStage = 'password' | 'recovery'

export function KeySetupFlow({
  onStage,
  onDone
}: {
  onStage?: (s: KeySetupStage) => void
  onDone: () => void
}) {
  const { user, info, openVault, refreshKeys } = useSession()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [material, setMaterial] = useState<{
    dek: Bytes
    recoveryKey: string
    body: KeysSetupBody
  } | null>(null)
  const email = user?.email ?? ''
  const { ok } = useNewPassword(pw, confirm, email)

  const generate = async (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!ok || !user) return
    setBusy(true)
    setError(null)
    try {
      const m = await createKeyMaterial(user.id, pw, ARGON2_DEFAULT, kekInWorker)
      setPw('')
      setConfirm('')
      setMaterial(m)
      onStage?.('recovery')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const upload = async () => {
    if (!material) return
    setBusy(true)
    setError(null)
    try {
      await api().setupKeys(material.body)
      await refreshKeys()
      await openVault(material.dek)
      material.dek.fill(0)
      onDone()
    } catch (err) {
      if (isApiError(err, 'keys_already_set')) {
        setError(
          'As chaves desta conta já foram definidas (talvez em outra aba). Desbloqueie com a senha.'
        )
        await refreshKeys()
        useSession.setState({ phase: 'locked' })
      } else setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (material)
    return (
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <RecoveryKeyPanel
          recoveryKey={material.recoveryKey}
          email={email}
          instanceName={info?.name ?? 'ClearChat'}
          onConfirmed={upload}
          confirmLabel="Guardei — concluir"
          busy={busy}
        />
      </div>
    )

  return (
    <form onSubmit={generate} className="space-y-5">
      <ul className="space-y-3 rounded-xl border border-border bg-bg/40 p-4 text-[13.5px] leading-relaxed text-muted">
        <li className="flex gap-3">
          <EyeOff className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          <span>
            Esta senha cifra seus dados <b className="text-fg">aqui, no seu navegador</b>. Ela nunca
            é enviada ao servidor.
          </span>
        </li>
        <li className="flex gap-3">
          <LockKeyhole className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          <span>
            É diferente do login: para <b className="text-fg">entrar</b> você usa o código por
            e-mail; para <b className="text-fg">ler os dados</b>, esta senha.
          </span>
        </li>
        <li className="flex gap-3">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          <span>
            Se esquecer, só a <b className="text-fg">chave de recuperação</b> (próximo passo)
            devolve o acesso. Sem as duas, ninguém consegue recuperar seus dados.
          </span>
        </li>
      </ul>
      {error && <Alert tone="danger">{error}</Alert>}
      <NewPasswordFields
        pw={pw}
        confirm={confirm}
        setPw={setPw}
        setConfirm={setConfirm}
        email={email}
        disabled={busy}
        showErrors={tried}
      />
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!ok}>
        {busy ? 'Gerando suas chaves…' : 'Gerar chaves'}
      </Button>
      {busy && (
        <p className="flex items-center justify-center gap-2 text-[12.5px] text-subtle">
          <Cpu className="size-3.5" /> Argon2id (64 MiB) rodando no seu navegador…
          <Spinner />
        </p>
      )}
    </form>
  )
}
