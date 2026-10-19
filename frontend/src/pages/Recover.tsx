// Recuperação (SYNC_PROTOCOL.md §5.5): chave de recuperação → DEK → senha nova obrigatória → (nova
// chave de recuperação, recomendado). E o último recurso: "perdi a senha e a chave" = zerar tudo.
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { ArrowLeft, KeyRound, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import { AuthLayout } from '../components/AuthLayout'
import { CodeInput } from '../components/CodeInput'
import { NewPasswordFields, useNewPassword } from '../components/NewPasswordFields'
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel'
import { toast } from '../components/toast'
import { Alert, Button, Field, FullPageSpinner, Input } from '../components/ui'
import {
  ARGON2_DEFAULT,
  type Bytes,
  normalizeRecoveryInput,
  passwordChangeBody,
  recoveryChangeBody,
  unlockWithRecovery
} from '../crypto'
import { errorMessage } from '../lib/errors'
import { kekInWorker } from '../lib/kdf'
import { useSession } from '../state/session'

type Step = 'key' | 'password' | 'offer' | 'newkey' | 'reset' | 'reset-code'

function formatTyping(v: string): string {
  const s = normalizeRecoveryInput(v)
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 36)
  return s.match(/.{1,4}/g)?.join('-') ?? ''
}

export default function Recover() {
  const { phase, user, keys, info, openVault, refreshKeys } = useSession()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('key')
  const [input, setInput] = useState('')
  const [dek, setDek] = useState<Bytes | null>(null)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const [newKey, setNewKey] = useState<Awaited<ReturnType<typeof recoveryChangeBody>> | null>(null)
  const [code, setCode] = useState('')
  const [ack, setAck] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const email = user?.email ?? ''
  const { ok: pwOk } = useNewPassword(pw, confirm, email)

  if (phase === 'boot') return <FullPageSpinner />
  if (phase === 'anon') return <Navigate to="/login?next=%2Frecover" replace />
  if (phase === 'needs_setup') return <Navigate to="/setup" replace />

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const useKey = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      if (!user || !keys) throw new Error('Sessão sem chaves.')
      setDek(await unlockWithRecovery(user.id, keys, input))
      setInput('')
      setStep('password')
    })
  }

  const setPassword = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!pwOk || !dek || !user) return
    void run(async () => {
      const body = await passwordChangeBody(user.id, dek, pw, ARGON2_DEFAULT, kekInWorker)
      await api().changePassword(body)
      setPw('')
      setConfirm('')
      await refreshKeys()
      setStep('offer')
    })
  }

  const finish = () =>
    run(async () => {
      if (dek) await openVault(dek)
      dek?.fill(0)
      navigate('/app', { replace: true })
    })

  if (step === 'password')
    return (
      <AuthLayout
        title="Defina uma senha nova"
        subtitle="Chave de recuperação aceita. Agora crie a nova senha de criptografia — a antiga deixa de valer em todos os dispositivos."
      >
        <form onSubmit={setPassword} className="space-y-5">
          {error && <Alert tone="danger">{error}</Alert>}
          <NewPasswordFields
            pw={pw}
            confirm={confirm}
            setPw={setPw}
            setConfirm={setConfirm}
            email={email}
            label="Nova senha de criptografia"
            disabled={busy}
            showErrors={tried}
          />
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={busy}
            disabled={!pwOk}
          >
            Salvar nova senha
          </Button>
          <p className="text-[12.5px] text-subtle">
            Seus outros dispositivos continuam funcionando: a chave dos dados não muda, só a forma
            de abri-la.
          </p>
        </form>
      </AuthLayout>
    )

  if (step === 'offer')
    return (
      <AuthLayout title="Senha trocada" subtitle="Quer gerar uma nova chave de recuperação também?">
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Alert tone="info">
            Recomendado se a chave antiga ficou exposta (por exemplo, digitada num computador que
            não é seu). A antiga deixa de funcionar quando você confirmar a nova.
          </Alert>
          <Button
            variant="primary"
            className="w-full"
            loading={busy}
            icon={<KeyRound className="size-4" />}
            onClick={() =>
              run(async () => {
                if (!dek || !user) return
                setNewKey(await recoveryChangeBody(user.id, dek))
                setStep('newkey')
              })
            }
          >
            Gerar nova chave de recuperação
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => void finish()} disabled={busy}>
            Agora não — ir para o painel
          </Button>
        </div>
      </AuthLayout>
    )

  if (step === 'newkey' && newKey)
    return (
      <AuthLayout
        wide
        title="Sua nova chave de recuperação"
        subtitle="Guarde-a antes de continuar."
      >
        {error && (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        )}
        <RecoveryKeyPanel
          recoveryKey={newKey.recoveryKey}
          email={email}
          instanceName={info?.name ?? 'ClearChat'}
          confirmLabel="Guardei — ativar a nova chave"
          busy={busy}
          onConfirmed={() =>
            run(async () => {
              await api().changeRecovery(newKey.body)
              await refreshKeys()
              toast('Nova chave de recuperação ativada.')
              await finish()
            })
          }
        />
      </AuthLayout>
    )

  if (step === 'reset' || step === 'reset-code')
    return (
      <AuthLayout
        title="Zerar a criptografia"
        subtitle="Último recurso, para quando você perdeu a senha E a chave de recuperação."
      >
        <div className="space-y-5">
          <Alert tone="danger" title="Isto apaga todos os seus dados na nuvem">
            Conversas, provedores, memórias e anexos sincronizados são apagados do servidor e você
            define uma senha nova. Os dados que ainda estiverem nos seus dispositivos voltam para a
            nuvem depois, cifrados com a chave nova.
          </Alert>
          {error && <Alert tone="danger">{error}</Alert>}
          {step === 'reset' ? (
            <>
              <Field label='Digite "APAGAR" para confirmar'>
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
                disabled={ack.trim().toUpperCase() !== 'APAGAR'}
                loading={busy}
                onClick={() =>
                  run(async () => {
                    await api().reauthRequest('reset_keys')
                    setStep('reset-code')
                  })
                }
              >
                Enviar código de confirmação
              </Button>
            </>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await api().resetKeys(code)
                  useSession.setState({ keys: null, vault: null, phase: 'needs_setup' })
                  navigate('/setup', { replace: true })
                })
              }}
            >
              <Field label={`Código enviado para ${email}`}>
                {(id) => (
                  <CodeInput id={id} value={code} onChange={setCode} autoFocus disabled={busy} />
                )}
              </Field>
              <Button
                type="submit"
                variant="danger"
                className="w-full"
                loading={busy}
                disabled={code.length !== 6}
              >
                Apagar tudo e recomeçar
              </Button>
            </form>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
            onClick={() => {
              setStep('key')
              setError(null)
            }}
          >
            <ArrowLeft className="size-3.5" /> Voltar
          </button>
        </div>
      </AuthLayout>
    )

  return (
    <AuthLayout
      title="Usar a chave de recuperação"
      subtitle={
        <>
          Digite a chave de 36 caracteres que você guardou ao criar a conta{' '}
          <b className="text-fg">{email}</b>.
        </>
      }
    >
      <form onSubmit={useKey} className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Chave de recuperação" hint="Maiúsculas, espaços e hífens não importam.">
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={input}
              onChange={(e) => setInput(formatTyping(e.target.value))}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[14px] tracking-wide uppercase"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          disabled={normalizeRecoveryInput(input).length !== 36}
          icon={<KeyRound className="size-4" />}
        >
          Recuperar acesso
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <Link to="/unlock" className="inline-flex items-center gap-1 text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" /> Lembrei a senha
        </Link>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-danger/90 hover:text-danger"
          onClick={() => {
            setStep('reset')
            setError(null)
          }}
        >
          <TriangleAlert className="size-3.5" /> Perdi a senha e a chave
        </button>
      </div>
    </AuthLayout>
  )
}
