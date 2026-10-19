// Desbloqueio: senha → Argon2id → desembrulha a DEK (só no navegador; senha errada = falha do GCM).
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { LockKeyhole, LogOut } from 'lucide-react'
import { AuthLayout } from '../components/AuthLayout'
import { Alert, Button, Field, FullPageSpinner, PasswordInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { safeNext } from '../lib/nav'
import { useSession } from '../state/session'

export default function Unlock() {
  const { phase, user, unlock, logout, lockReason } = useSession()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeNext(params.get('next'))
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (phase === 'boot') return <FullPageSpinner />
  if (phase === 'anon') return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  if (phase === 'needs_setup') return <Navigate to="/setup" replace />
  if (phase === 'unlocked' && !busy) return <Navigate to={next} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!pw) return
    setBusy(true)
    setError(null)
    try {
      await unlock(pw)
      setPw('')
      navigate(next, { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Desbloquear seus dados"
      subtitle={
        <>
          Conectado como <b className="text-fg">{user?.email}</b>. Digite a senha de criptografia —
          ela não sai deste navegador.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {lockReason === 'idle' && (
          <Alert tone="info">Bloqueado por inatividade: as chaves saíram da memória.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Senha de criptografia">
          {(id) => (
            <PasswordInput
              id={id}
              autoFocus
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          disabled={!pw}
          icon={<LockKeyhole className="size-4" />}
        >
          {busy ? 'Desbloqueando…' : 'Desbloquear'}
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <Link to="/recover" className="text-accent-strong hover:underline">
          Esqueci a senha — usar a chave de recuperação
        </Link>
        <button
          type="button"
          onClick={() => void logout().then(() => navigate('/login'))}
          className="inline-flex items-center gap-1.5 text-muted hover:text-fg"
        >
          <LogOut className="size-3.5" /> Sair
        </button>
      </div>
    </AuthLayout>
  )
}
