// Senha de criptografia nova (2×) com medidor de força e a política do contrato.
import { useMemo } from 'react'
import { passwordStrength } from '../lib/password'
import { PasswordMeter } from './PasswordMeter'
import { Field, PasswordInput } from './ui'

export function useNewPassword(pw: string, confirm: string, email: string) {
  const strength = useMemo(() => passwordStrength(pw, email), [pw, email])
  const mismatch = confirm.length > 0 && pw !== confirm
  return { strength, mismatch, ok: strength.ok && pw === confirm && pw.length > 0 }
}

export function NewPasswordFields({
  pw,
  confirm,
  setPw,
  setConfirm,
  email,
  label = 'Senha de criptografia',
  disabled,
  showErrors
}: {
  pw: string
  confirm: string
  setPw: (v: string) => void
  setConfirm: (v: string) => void
  email: string
  label?: string
  disabled?: boolean
  showErrors?: boolean
}) {
  const { strength, mismatch } = useNewPassword(pw, confirm, email)
  return (
    <div className="space-y-4">
      <Field label={label} error={showErrors && pw ? strength.errors[0] : undefined}>
        {(id) => (
          <div className="space-y-2">
            <PasswordInput
              id={id}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
              disabled={disabled}
              placeholder="Pelo menos 10 caracteres"
            />
            <PasswordMeter strength={strength} empty={!pw} />
          </div>
        )}
      </Field>
      <Field label="Confirme a senha" error={mismatch ? 'As senhas não conferem.' : undefined}>
        {(id) => (
          <PasswordInput
            id={id}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={disabled}
          />
        )}
      </Field>
    </div>
  )
}
