// Cadastro (SYNC_PROTOCOL.md §5.1): e-mail + nome (+ Turnstile, + convite) → código → senha de
// criptografia e chaves geradas no navegador → chave de recuperação (uma vez) → pronto.
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, CheckCircle2, Laptop, MailCheck, UserPlus } from 'lucide-react'
import { api } from '../api'
import { AuthLayout } from '../components/AuthLayout'
import { CodeInput } from '../components/CodeInput'
import { KeySetupFlow, type KeySetupStage } from '../components/KeySetupFlow'
import { Turnstile } from '../components/Turnstile'
import { Alert, Button, Field, FullPageSpinner, Input } from '../components/ui'
import { webDevice } from '../lib/device'
import { errorMessage } from '../lib/errors'
import { useSession } from '../state/session'

type Step = 'details' | 'code' | 'keys' | 'done'

export default function Signup() {
  const { info, phase, user, applyAuth } = useSession()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const invite = params.get('invite')
  const fromApp = params.get('from') === 'app'
  const [inviteState, setInviteState] = useState<'checking' | 'valid' | 'invalid' | null>(
    invite ? 'checking' : null
  )
  const [inviteEmail, setInviteEmail] = useState<string | null>(null)
  const [rawStep, setStep] = useState<Step>('details')
  const [keyStage, setKeyStage] = useState<KeySetupStage>('password')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [widgetKey, setWidgetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const captcha = info?.features.captcha ?? null

  useEffect(() => {
    if (!invite) return
    let alive = true
    api()
      .inviteCheck(invite)
      .then(
        (r) => {
          if (!alive) return
          setInviteState(r.valid ? 'valid' : 'invalid')
          if (r.valid && r.email) {
            setInviteEmail(r.email)
            setEmail(r.email)
          }
        },
        () => alive && setInviteState('invalid')
      )
    return () => {
      alive = false
    }
  }, [invite])

  // Conta criada mas sem chaves (aba fechada no meio): continua na etapa da senha.
  const step: Step =
    phase === 'needs_setup' && (rawStep === 'details' || rawStep === 'code') ? 'keys' : rawStep

  if (!info || phase === 'boot' || inviteState === 'checking') return <FullPageSpinner />

  if ((phase === 'locked' || phase === 'unlocked') && (step === 'details' || step === 'code'))
    return (
      <AuthLayout title="Você já está conectado" subtitle={`Conta: ${user?.email}`}>
        <Button variant="primary" className="w-full" onClick={() => navigate('/app')}>
          Ir para o painel
        </Button>
      </AuthLayout>
    )

  if (invite && inviteState === 'invalid')
    return (
      <AuthLayout
        title="Convite inválido"
        subtitle="Este link de convite não existe, já foi usado ou expirou."
      >
        <p className="text-sm text-muted">Peça um novo convite a quem administra esta instância.</p>
        <Link
          to="/login"
          className="mt-6 block text-center text-sm text-accent-strong hover:underline"
        >
          Já tenho conta — entrar
        </Link>
      </AuthLayout>
    )

  if (!invite && !info.features.signupOpen && step === 'details')
    return (
      <AuthLayout
        title="Cadastro fechado"
        subtitle={`${info.name} não aceita cadastros públicos. Para entrar, você precisa de um convite de quem administra a instância.`}
      >
        <Button variant="primary" className="w-full" onClick={() => navigate('/login')}>
          Já tenho conta — entrar
        </Button>
      </AuthLayout>
    )

  const start = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (captcha && !token) {
      setError('Confirme a verificação anti-robô.')
      return
    }
    setBusy(true)
    try {
      await api().signupStart({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        ...(captcha && token ? { turnstile_token: token } : {}),
        ...(invite ? { invite_token: invite } : {})
      })
      setStep('code')
      setCode('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setToken(null)
      setWidgetKey((k) => k + 1)
      setBusy(false)
    }
  }

  const verify = async (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const r = await api().signupVerify({
        email: email.trim().toLowerCase(),
        code,
        device: webDevice()
      })
      applyAuth(r)
      setStep('keys')
    } catch (err) {
      setError(errorMessage(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const stepNo =
    step === 'details'
      ? 1
      : step === 'code'
        ? 2
        : step === 'keys'
          ? keyStage === 'password'
            ? 3
            : 4
          : 4
  const stepper = { current: stepNo, total: 4 }

  if (step === 'done')
    return (
      <AuthLayout title="Tudo pronto" step={{ current: 4, total: 4, label: 'Concluído' }}>
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-xl border border-success/25 bg-success/[0.07] p-4 text-sm">
            <CheckCircle2 className="size-5 shrink-0 text-success" />
            <span>
              Sua conta e suas chaves foram criadas. Seus dados serão cifrados ponta a ponta.
            </span>
          </div>
          {fromApp ? (
            <div className="space-y-3 text-sm text-muted">
              <p className="flex items-start gap-2">
                <Laptop className="mt-0.5 size-4 shrink-0 text-accent-strong" />
                <span>
                  <b className="text-fg">Volte ao app e entre</b> com o seu e-mail (
                  {email || user?.email}). Lá, desbloqueie com a senha de criptografia que você
                  acabou de criar.
                </span>
              </p>
              <Button className="w-full" onClick={() => navigate('/app')}>
                Abrir o painel no navegador
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted">
                Baixe o app, entre com o mesmo e-mail e desbloqueie com a sua senha. Pelo painel
                você gerencia conversas, provedores e dispositivos.
              </p>
              <Button variant="primary" className="w-full" onClick={() => navigate('/app')}>
                Ir para o painel
              </Button>
            </>
          )}
        </div>
      </AuthLayout>
    )

  if (step === 'keys')
    return (
      <AuthLayout
        wide
        step={stepper}
        title={
          keyStage === 'password'
            ? 'Crie sua senha de criptografia'
            : 'Guarde sua chave de recuperação'
        }
        subtitle={
          keyStage === 'password'
            ? 'Ela protege suas conversas, chaves de API e memórias antes de saírem do navegador.'
            : 'Se você esquecer a senha, esta chave é a única forma de recuperar seus dados.'
        }
      >
        <KeySetupFlow onStage={setKeyStage} onDone={() => setStep('done')} />
      </AuthLayout>
    )

  if (step === 'code')
    return (
      <AuthLayout
        step={stepper}
        title="Confirme seu e-mail"
        subtitle={
          <>
            Enviamos um código de 6 dígitos para <b className="text-fg">{email}</b>. Ele vale por 10
            minutos.
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
                    setTimeout(() => document.getElementById('signup-verify')?.click(), 0)
                }}
                disabled={busy}
              />
            )}
          </Field>
          <Button
            id="signup-verify"
            type="submit"
            variant="primary"
            className="w-full"
            loading={busy}
            disabled={code.length !== 6}
            icon={<MailCheck className="size-4" />}
          >
            Confirmar
          </Button>
          <p className="text-[12.5px] leading-relaxed text-subtle">
            Não chegou? Confira o spam. Se você já tinha conta com este e-mail, mandamos um aviso em
            vez do código — nesse caso,{' '}
            <Link to="/login" className="text-accent-strong hover:underline">
              entre
            </Link>
            .
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
            onClick={() => {
              setStep('details')
              setError(null)
            }}
          >
            <ArrowLeft className="size-3.5" /> Corrigir dados ou reenviar
          </button>
        </form>
      </AuthLayout>
    )

  return (
    <AuthLayout
      step={stepper}
      title={invite ? 'Você foi convidado' : `Criar conta${info.name ? ` em ${info.name}` : ''}`}
      subtitle="Sua conta sincroniza o ClearChat entre dispositivos — com tudo cifrado no seu navegador."
    >
      <form onSubmit={start} className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Nome">
          {(id) => (
            <Input
              id={id}
              required
              autoComplete="name"
              autoFocus
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como quer ser chamado"
            />
          )}
        </Field>
        <Field
          label="E-mail"
          hint={
            inviteEmail
              ? 'Este convite é para este e-mail.'
              : 'Usado para entrar (código por e-mail).'
          }
        >
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              autoComplete="email"
              value={email}
              readOnly={!!inviteEmail}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
            />
          )}
        </Field>
        {captcha && (
          <Turnstile
            key={widgetKey}
            siteKey={captcha.siteKey}
            action="signup"
            onToken={setToken}
            onError={setError}
          />
        )}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          disabled={!email || !name.trim() || (!!captcha && !token)}
          icon={<UserPlus className="size-4" />}
        >
          Continuar
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px] text-muted">
        Já tem conta?{' '}
        <Link to="/login" className="font-medium text-accent-strong hover:underline">
          Entrar
        </Link>
      </p>
    </AuthLayout>
  )
}
