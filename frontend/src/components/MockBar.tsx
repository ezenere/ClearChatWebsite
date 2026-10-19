// Barra do modo de API simulada (só `VITE_MOCK_API=1`): código, conta demo e simulações.
import { useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { Button } from './ui'

export function MockBar() {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(
    () => navigator.webdriver && !new URLSearchParams(location.search).has('mock_bar')
  )
  const m = window.__mock
  if (!m || hidden) return null
  const cfg = m.server.db.config
  const toggle = (k: 'landing' | 'signupOpen' | 'captcha') => {
    m.setConfig({ [k]: !cfg[k] })
    location.reload()
  }
  return (
    <div className="no-print fixed bottom-3 left-3 z-[70] text-[12px]">
      {open ? (
        <div className="w-72 space-y-3 rounded-xl border border-warning/30 bg-elevated p-3 shadow-popover">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium text-warning">
              <FlaskConical className="size-3.5" /> API simulada
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-subtle hover:text-fg"
              aria-label="Fechar"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <dl className="space-y-1 text-muted">
            <div>
              Código por e-mail: <b className="font-mono text-fg">{cfg.code}</b>
            </div>
            <div>
              Demo: <b className="text-fg">{m.demo.email}</b>
            </div>
            <div>
              Senha: <b className="font-mono text-fg">{m.demo.password}</b>
            </div>
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => toggle('landing')}>
              Landing: {cfg.landing ? 'on' : 'off'}
            </Button>
            <Button size="sm" onClick={() => toggle('signupOpen')}>
              Cadastro: {cfg.signupOpen ? 'aberto' : 'fechado'}
            </Button>
            <Button size="sm" onClick={() => toggle('captcha')}>
              Captcha: {cfg.captcha ? 'on' : 'off'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => void m.remoteNewChat()}>
              Chat remoto
            </Button>
            <Button size="sm" onClick={() => m.remoteDeleteChat()}>
              Apagar remoto
            </Button>
            <Button size="sm" variant="danger-soft" onClick={() => m.reset()}>
              Resetar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
              Esconder
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-elevated px-3 py-1.5 text-warning shadow-popover"
        >
          <FlaskConical className="size-3.5" /> API simulada · código {cfg.code}
        </button>
      )}
    </div>
  )
}
