// Moldura das telas de autenticação: logo, cartão central, rodapé com a instância.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useSession } from '../state/session'
import { Wordmark } from './Logo'
import { cx } from './ui'

export function AuthLayout({
  title,
  subtitle,
  children,
  wide,
  step
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  wide?: boolean
  step?: { current: number; total: number; label?: string }
}) {
  const info = useSession((s) => s.info)
  return (
    <div className="glow flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8 sm:py-6">
        <Link to="/" className="rounded-lg" aria-label="Início">
          <Wordmark name={info?.name ?? 'ClearChat'} />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-2 pb-12 sm:items-center sm:pt-0">
        <div className={cx('w-full animate-slide-up', wide ? 'max-w-xl' : 'max-w-md')}>
          {step && (
            <div className="mb-4 flex items-center gap-3">
              <div className="flex flex-1 gap-1.5">
                {Array.from({ length: step.total }, (_, i) => (
                  <div
                    key={i}
                    className={cx(
                      'h-1 flex-1 rounded-full',
                      i < step.current ? 'bg-accent' : 'bg-active'
                    )}
                  />
                ))}
              </div>
              <span className="text-[12px] text-subtle">
                {step.label ?? `Etapa ${step.current} de ${step.total}`}
              </span>
            </div>
          )}
          <div className="rounded-2xl border border-border bg-surface/90 p-5 shadow-modal backdrop-blur sm:p-8">
            <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
      <footer className="px-4 pb-6 text-center text-[12px] text-faint">
        Criptografia ponta a ponta · a senha e as chaves nunca saem do seu navegador
      </footer>
    </div>
  )
}
