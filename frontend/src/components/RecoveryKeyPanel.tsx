// Mostra a chave de recuperação UMA vez: copiar / baixar .txt / imprimir, e exige a confirmação
// explícita ("guardei" + os 4 últimos caracteres) antes de seguir (SYNC_PROTOCOL.md §3.5).
import { useState } from 'react'
import { Download, KeyRound, Printer } from 'lucide-react'
import { normalizeRecoveryInput } from '../crypto'
import { publicBaseUrl } from '../api/config'
import { formatDateTime } from '../lib/format'
import { Alert, Button, CopyButton, Field, Input } from './ui'

export function RecoveryKeyPanel({
  recoveryKey,
  email,
  instanceName,
  onConfirmed,
  confirmLabel = 'Continuar',
  busy
}: {
  recoveryKey: string
  email: string
  instanceName: string
  onConfirmed: () => void
  confirmLabel?: string
  busy?: boolean
}) {
  const [saved, setSaved] = useState(false)
  const [last4, setLast4] = useState('')
  const [createdAt] = useState(() => Date.now())
  const groups = recoveryKey.split('-')
  const expected = recoveryKey.replace(/-/g, '').slice(-4)
  const last4ok = normalizeRecoveryInput(last4) === expected
  const text = [
    `${instanceName} — chave de recuperação`,
    '',
    `Conta: ${email}`,
    `Servidor: ${publicBaseUrl()}`,
    `Gerada em: ${formatDateTime(createdAt)}`,
    '',
    recoveryKey,
    '',
    'Com esta chave você recupera seus dados se esquecer a senha de criptografia.',
    'Guarde-a em um lugar seguro (gerenciador de senhas ou papel). Ninguém — nem o',
    'servidor — consegue recuperá-la para você. Quem tiver esta chave e acesso ao seu',
    'e-mail consegue ler seus dados: não compartilhe.',
    ''
  ].join('\n')

  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'clearchat-chave-de-recuperacao.txt'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-5">
      <div className="print-sheet space-y-4">
        <div className="hidden print:block">
          <p className="text-lg font-semibold">{instanceName} — chave de recuperação</p>
          <p className="text-sm">Conta: {email}</p>
          <p className="text-sm">Servidor: {publicBaseUrl()}</p>
          <p className="text-sm">Gerada em: {formatDateTime(createdAt)}</p>
        </div>
        <div
          className="rounded-2xl border border-accent/30 bg-gradient-to-b from-accent-soft to-transparent p-4 sm:p-5"
          data-testid="recovery-key"
          aria-label="Chave de recuperação"
        >
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-accent-strong no-print">
            <KeyRound className="size-4" /> Sua chave de recuperação
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[15px] font-medium tracking-wider text-fg sm:text-lg">
            {groups.map((g, i) => (
              <span
                key={i}
                className="rounded-lg border border-border bg-bg/70 py-2 text-center select-all"
              >
                {g}
              </span>
            ))}
          </div>
        </div>
        <p className="hidden text-sm print:block">
          Guarde em lugar seguro. Ninguém — nem o servidor — consegue recuperá-la para você.
        </p>
      </div>

      <div className="no-print grid grid-cols-3 gap-2">
        <CopyButton text={recoveryKey} size="md" className="w-full" />
        <Button
          type="button"
          icon={<Download className="size-4" />}
          onClick={download}
          className="w-full"
        >
          Baixar
        </Button>
        <Button
          type="button"
          icon={<Printer className="size-4" />}
          onClick={() => window.print()}
          className="w-full"
        >
          Imprimir
        </Button>
      </div>

      <Alert tone="warning" title="Ela aparece só agora" className="no-print">
        Sem a senha de criptografia <em>e</em> sem esta chave, seus dados ficam ilegíveis para
        sempre — nem nós conseguimos recuperá-los. Guarde-a fora deste computador.
      </Alert>

      <div className="no-print space-y-4 rounded-xl border border-border bg-bg/40 p-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>Guardei minha chave de recuperação em um lugar seguro.</span>
        </label>
        <Field
          label="Para confirmar, digite os 4 últimos caracteres"
          error={last4.length >= 4 && !last4ok ? 'Não confere com o fim da chave.' : undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={last4}
              onChange={(e) => setLast4(e.target.value.slice(0, 6))}
              placeholder="XXXX"
              autoComplete="off"
              spellCheck={false}
              className="max-w-[10rem] font-mono uppercase tracking-widest"
            />
          )}
        </Field>
        <Button
          variant="primary"
          className="w-full"
          disabled={!saved || !last4ok}
          loading={busy}
          onClick={onConfirmed}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
