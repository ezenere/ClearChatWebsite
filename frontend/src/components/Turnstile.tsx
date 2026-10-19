// Widget do Cloudflare Turnstile (só quando a instância tem captcha). No modo de API simulada, uma
// caixa falsa substitui o widget (o build de produção não contém esse atalho).
import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button, cx } from './ui'

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id?: string) => void
  remove: (id?: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!loading)
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = SCRIPT
      s.async = true
      s.onload = () =>
        window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'))
      s.onerror = () => {
        loading = null
        reject(new Error('Não foi possível carregar a verificação anti-robô.'))
      }
      document.head.appendChild(s)
    })
  return loading
}

export interface TurnstileProps {
  siteKey: string
  action: 'login' | 'signup'
  cData?: string
  onToken: (token: string | null) => void
  onError?: (msg: string) => void
  className?: string
}

export function Turnstile(props: TurnstileProps) {
  if (import.meta.env.VITE_MOCK_API === '1' && props.siteKey.startsWith('mock'))
    return <FakeTurnstile {...props} />
  return <RealTurnstile {...props} />
}

function RealTurnstile({ siteKey, action, cData, onToken, onError, className }: TurnstileProps) {
  const el = useRef<HTMLDivElement>(null)
  const cb = useRef({ onToken, onError })
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    cb.current = { onToken, onError }
  })
  useEffect(() => {
    let id: string | undefined
    let api: TurnstileApi | undefined
    let alive = true
    loadTurnstile().then(
      (t) => {
        if (!alive || !el.current) return
        api = t
        id = t.render(el.current, {
          sitekey: siteKey,
          action,
          cData,
          theme: 'dark',
          language: 'pt-br',
          callback: (token: string) => cb.current.onToken(token),
          'expired-callback': () => cb.current.onToken(null),
          'error-callback': () => {
            cb.current.onToken(null)
            cb.current.onError?.('A verificação anti-robô falhou.')
          }
        })
      },
      (e: Error) => {
        setFailed(e.message)
        cb.current.onError?.(e.message)
      }
    )
    return () => {
      alive = false
      if (api && id) api.remove(id)
    }
  }, [siteKey, action, cData])
  return (
    <div className={cx('min-h-[65px]', className)}>
      <div ref={el} />
      {failed && <p className="text-[13px] text-danger">{failed}</p>}
    </div>
  )
}

function FakeTurnstile({ action, cData, onToken, className }: TurnstileProps) {
  const [done, setDone] = useState(false)
  return (
    <div
      className={cx(
        'flex h-[65px] items-center justify-between gap-3 rounded-lg border border-dashed border-border-strong bg-elevated px-3',
        className
      )}
      data-testid="fake-turnstile"
    >
      <span className="flex items-center gap-2 text-[13px] text-muted">
        <ShieldCheck className={cx('size-4', done ? 'text-success' : 'text-subtle')} />
        {done ? 'Verificado (simulado)' : 'Captcha simulado'}
      </span>
      <Button
        type="button"
        size="sm"
        disabled={done}
        onClick={() => {
          setDone(true)
          onToken(`mock-turnstile.${action}.${cData ?? ''}.${Date.now()}`)
        }}
      >
        Não sou um robô
      </Button>
    </div>
  )
}
