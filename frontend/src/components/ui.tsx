// Componentes básicos no estilo do app desktop (escuro, bordas finas, violeta).
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
  X,
  XCircle
} from 'lucide-react'

export const cx = (...c: (string | false | null | undefined)[]): string =>
  c.filter(Boolean).join(' ')

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-white hover:bg-[#9a70f8] active:bg-[#7c4ff0] shadow-[0_1px_0_rgb(255_255_255/0.12)_inset,0_8px_24px_-12px_rgb(139_92_246/0.7)]',
  secondary: 'bg-elevated text-fg border border-border hover:bg-hover hover:border-border-strong',
  ghost: 'text-muted hover:text-fg hover:bg-hover',
  danger: 'bg-danger/90 text-[#1a0606] hover:bg-danger font-semibold',
  'danger-soft': 'text-danger border border-danger/30 bg-danger/5 hover:bg-danger/10'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-[15px]',
        VARIANT[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 text-muted', className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label && <span className="text-sm">{label}</span>}
    </span>
  )
}

export function FullPageSpinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner label={label} />
    </div>
  )
}

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: (id: string) => ReactNode
  className?: string
  right?: ReactNode
}

export function Field({ label, hint, error, children, className, right }: FieldProps) {
  const id = useId()
  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-muted">
          {label}
        </label>
        {right}
      </div>
      {children(id)}
      {error ? (
        <p className="text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] leading-relaxed text-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx('field', className)} {...rest} />
  }
)

export const PasswordInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { revealLabel?: string }
>(function PasswordInput({ className, revealLabel = 'Mostrar', ...rest }, ref) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        ref={ref}
        type={show ? 'text' : 'password'}
        className={cx('field pr-11', className)}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle hover:text-fg"
        aria-label={show ? 'Ocultar' : revealLabel}
        title={show ? 'Ocultar' : revealLabel}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
})

export function Card({
  children,
  className,
  title,
  description,
  actions
}: {
  children?: ReactNode
  className?: string
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className={cx('rounded-2xl border border-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-fg">{title}</h2>}
            {description && (
              <p className="mt-1 text-[13px] leading-relaxed text-subtle">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="p-5">{children}</div>}
    </section>
  )
}

const ALERT = {
  info: { cls: 'border-accent/25 bg-accent-soft text-fg', Icon: Info, icon: 'text-accent-strong' },
  warning: {
    cls: 'border-warning/30 bg-warning/[0.07] text-fg',
    Icon: AlertTriangle,
    icon: 'text-warning'
  },
  danger: { cls: 'border-danger/30 bg-danger/[0.07] text-fg', Icon: XCircle, icon: 'text-danger' },
  success: {
    cls: 'border-success/30 bg-success/[0.07] text-fg',
    Icon: CheckCircle2,
    icon: 'text-success'
  }
}

export function Alert({
  tone = 'info',
  title,
  children,
  className
}: {
  tone?: keyof typeof ALERT
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const a = ALERT[tone]
  return (
    <div
      className={cx(
        'flex gap-3 rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed',
        a.cls,
        className
      )}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <a.Icon className={cx('mt-0.5 size-4 shrink-0', a.icon)} aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted">{children}</div>}
      </div>
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium',
        tone === 'neutral' && 'border-border bg-elevated text-muted',
        tone === 'accent' && 'border-accent/30 bg-accent-soft text-accent-strong',
        tone === 'success' && 'border-success/25 bg-success/10 text-success',
        tone === 'warning' && 'border-warning/25 bg-warning/10 text-warning',
        tone === 'danger' && 'border-danger/25 bg-danger/10 text-danger',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const first = panel.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-close])'
    )
    first?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cx(
          'relative max-h-[92vh] w-full animate-pop-in overflow-y-auto rounded-t-2xl border border-border bg-elevated shadow-modal sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md'
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            data-close
            onClick={onClose}
            className="-mr-1 rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
            aria-label="Fechar"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirmar',
  danger,
  busy
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  children: ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </Modal>
  )
}

export function CopyButton({
  text,
  label = 'Copiar',
  className,
  size = 'sm',
  variant = 'secondary'
}: {
  text: string
  label?: string
  className?: string
  size?: 'sm' | 'md'
  variant?: Variant
}) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(t)
  }, [done])
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      icon={done ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
        } catch {
          /* sem permissão de área de transferência */
        }
      }}
    >
      {done ? 'Copiado' : label}
    </Button>
  )
}

export function EmptyState({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-elevated text-subtle">
        {icon}
      </div>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-subtle">{children}</div>}
    </div>
  )
}
