// Login: e-mail (+ Turnstile, se a instância tiver captcha) → código de 6 dígitos (SYNC_PROTOCOL.md §5.2).
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, Mail } from 'lucide-react'
import { api } from '../api'
import { errorMessage } from '../lib/errors'
import { AuthLayout } from '../components/AuthLayout'
import { CodeInput } from '../components/CodeInput'
import { Turnstile } from '../components/Turnstile'
import { Alert, Button, Field, Input } from '../components/ui'
import { webDevice } from '../lib/device'
import { safeNext } from '../lib/nav'
import { useSession } from '../state/session'

export default function Login() {
  const { info, applyAuth, endedReason } = useSession()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeNext(params.get('next'))
  const captcha = info?.features.captcha ?? null
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [code, setCode] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [widgetKey, setWidgetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (captcha && !token) {
      setError('Confirme a verificação anti-robô.')
      return
    }
    setBusy(true)
    try {
      await api().codeRequest({
        email: email.trim().toLowerCase(),
        ...(captcha && token ? { turnstile_token: token } : {})
      })
      setStep('code')
      setCode('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      // o token do Turnstile é de uso único
      setToken(null)
      setWidgetKey((k) => k + 1)
      setBusy(false)
    }
  }

  const verify = async (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length !== 6) return
    setError(null)
    setBusy(true)
    try {
      const r = await api().codeVerify({
        email: email.trim().toLowerCase(),
        code,
        device: webDevice()
      })
      applyAuth(r)
      navigate(r.keys_ready ? `/unlock?next=${encodeURIComponent(next)}` : '/setup', {
        replace: true
      })
    } catch (err) {
      setError(errorMessage(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code')
    return (
      <AuthLayout
        title="Digite o código"
        subtitle={
          <>
            Se existir uma conta para <b className="text-fg">{email}</b>, enviamos um código de 6
            dígitos. Ele vale por 10 minutos.
          </>
        }
      >
        <form onSubmit={verify} className="space-y-5">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Código">
            {(id) => (
              <CodeInput
                id={id}
                value={code}
                autoFocus
                onChange={(v) => {
                  setCode(v)
                  if (v.length === 6)
                    setTimeout(() => document.getElementById('verify-btn')?.click(), 0)
                }}
                disabled={busy}
              />
            )}
          </Field>
          <Button
            id="verify-btn"
            type="submit"
            variant="primary"
            className="w-full"
            loading={busy}
            disabled={code.length !== 6}
          >
            Entrar
          </Button>
          <div className="flex items-center justify-between text-[13px]">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted hover:text-fg"
              onClick={() => {
                setStep('email')
                setError(null)
              }}
            >
              <ArrowLeft className="size-3.5" /> Outro e-mail
            </button>
            <button
              type="button"
              className="text-accent-strong hover:underline"
              onClick={() => {
                setStep('email')
                setError(null)
              }}
            >
              Reenviar código
            </button>
          </div>
        </form>
      </AuthLayout>
    )

  return (
    <AuthLayout
      title={`Entrar${info ? ` em ${info.name}` : ''}`}
      subtitle="Sem senha para entrar: mandamos um código para o seu e-mail."
    >
      <form onSubmit={request} className="space-y-5">
        {endedReason && <Alert tone="warning">{endedReason}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="E-mail">
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
            />
          )}
        </Field>
        {captcha && (
          <Turnstile
            key={widgetKey}
            siteKey={captcha.siteKey}
            action="login"
            onToken={setToken}
            onError={setError}
          />
        )}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          icon={<Mail className="size-4" />}
          disabled={!email || (!!captcha && !token)}
        >
          Enviar código
        </Button>
      </form>
      {info?.features.signupOpen && (
        <p className="mt-6 text-center text-[13px] text-muted">
          Não tem conta?{' '}
          <Link to="/signup" className="font-medium text-accent-strong hover:underline">
            Criar conta
          </Link>
        </p>
      )}
    </AuthLayout>
  )
}
