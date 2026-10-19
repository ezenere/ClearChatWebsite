// Página do captcha para o app (SYNC_PROTOCOL.md §15). O app abre
//   <base>/captcha?client=app&nonce=<16+ base64url>&action=login|signup
// numa janela isolada; no sucesso navegamos (navegação de verdade, que o app intercepta em
// will-navigate) para <base>/captcha/done#token=<turnstile_token>&nonce=<nonce>. O fragmento nunca vai
// ao servidor nem a logs.
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { CheckCircle2, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { publicBaseUrl } from '../api/config'
import { AppIcon } from '../components/Logo'
import { Turnstile } from '../components/Turnstile'
import { Button, FullPageSpinner } from '../components/ui'
import { useSession } from '../state/session'
import { captchaDoneUrl, NONCE_RE } from '../lib/captcha'

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 text-center shadow-modal">
        <AppIcon className="mx-auto mb-4 size-10" />
        {children}
      </div>
    </div>
  )
}

export default function Captcha() {
  const info = useSession((s) => s.info)
  const [params] = useSearchParams()
  const nonce = params.get('nonce') ?? ''
  const rawAction = params.get('action')
  const action = rawAction === 'signup' ? 'signup' : 'login'
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<'idle' | 'error' | 'done'>('idle')

  if (!info) return <FullPageSpinner />

  if (!NONCE_RE.test(nonce) || (rawAction && rawAction !== 'login' && rawAction !== 'signup'))
    return (
      <Frame>
        <ShieldAlert className="mx-auto mb-2 size-6 text-danger" />
        <h1 className="font-semibold">Link de verificação inválido</h1>
        <p className="mt-2 text-sm text-muted">
          Feche esta janela e tente entrar de novo pelo app.
        </p>
      </Frame>
    )

  if (!info.features.captcha)
    return (
      <Frame>
        <h1 className="font-semibold">Sem verificação nesta instância</h1>
        <p className="mt-2 text-sm text-muted">
          {info.name} não usa captcha. Pode fechar esta janela e continuar no app.
        </p>
      </Frame>
    )

  if (state === 'done')
    return (
      <Frame>
        <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
        <h1 className="font-semibold">Verificado</h1>
        <p className="mt-2 text-sm text-muted">Voltando ao app…</p>
      </Frame>
    )

  return (
    <Frame>
      <h1 className="flex items-center justify-center gap-2 font-semibold">
        <ShieldCheck className="size-4 text-accent-strong" /> Confirme que você é humano
      </h1>
      <p className="mt-2 mb-5 text-sm text-muted">
        {action === 'signup' ? 'Para criar a conta' : 'Para entrar'} em{' '}
        <b className="text-fg">{info.name}</b>.
      </p>
      {state === 'error' ? (
        <div className="space-y-3">
          <p className="text-sm text-danger">A verificação falhou ou expirou.</p>
          <Button
            icon={<RotateCw className="size-4" />}
            onClick={() => {
              setState('idle')
              setAttempt((a) => a + 1)
            }}
          >
            Tentar de novo
          </Button>
        </div>
      ) : (
        <div className="flex justify-center">
          <Turnstile
            key={attempt}
            siteKey={info.features.captcha.siteKey}
            action={action}
            cData={nonce}
            onToken={(token) => {
              if (!token) {
                setState('error')
                return
              }
              setState('done')
              window.location.assign(captchaDoneUrl(publicBaseUrl(), token, nonce))
            }}
            onError={() => setState('error')}
          />
        </div>
      )}
    </Frame>
  )
}

/** Destino do handshake. Normalmente o app intercepta antes de carregar; se não, só avisa. */
export function CaptchaDone() {
  return (
    <Frame>
      <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
      <h1 className="font-semibold">Verificação concluída</h1>
      <p className="mt-2 text-sm text-muted">Você já pode fechar esta janela.</p>
    </Frame>
  )
}
