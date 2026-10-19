// Campo do código de 6 dígitos enviado por e-mail.
import { forwardRef } from 'react'
import { cx } from './ui'

export const CodeInput = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (v: string) => void
    id?: string
    disabled?: boolean
    autoFocus?: boolean
  }
>(function CodeInput({ value, onChange, id, disabled, autoFocus }, ref) {
  return (
    <input
      ref={ref}
      id={id}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="000000"
      aria-label="Código de 6 dígitos"
      className={cx(
        'field h-14 text-center font-mono !text-2xl tracking-[0.5em] placeholder:tracking-[0.5em] placeholder:text-faint'
      )}
    />
  )
})
