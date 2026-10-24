// Demonstração das aprovações: o agente pede comandos, cada sub-comando de `a && b | c` recebe um
// veredito (whitelist, Smart-Approve, blacklist) e, quando a política é "perguntar", quem decide é
// quem está olhando.
import { useEffect, useState } from 'react'
import { Check, RotateCcw, ShieldAlert, ShieldCheck, Sparkles, X } from 'lucide-react'
import { cx } from '../../components/ui'
import { useInView } from './hooks'

type Verdict = 'allow' | 'smart' | 'ask' | 'deny'
type Part = { text: string; verdict: Verdict; why: string }
type Step = { parts: Part[]; sep: string[]; outcome: 'auto' | 'ask' | 'deny'; out: string }

const STEPS: Step[] = [
  {
    parts: [{ text: 'git status --short', verdict: 'allow', why: 'whitelist' }],
    sep: [],
    outcome: 'auto',
    out: ' M src/pages/Landing.tsx'
  },
  {
    parts: [
      { text: 'npm run build', verdict: 'allow', why: 'whitelist' },
      { text: 'npm test', verdict: 'allow', why: 'whitelist' },
      { text: 'tee test.log', verdict: 'smart', why: 'Smart-Approve: só grava um log no projeto' }
    ],
    sep: ['&&', '|'],
    outcome: 'auto',
    out: '✓ 42 testes passaram'
  },
  {
    parts: [
      { text: 'rm -rf dist', verdict: 'ask', why: 'apaga arquivos — a política é perguntar' },
      { text: 'vite build', verdict: 'allow', why: 'whitelist' }
    ],
    sep: ['&&'],
    outcome: 'ask',
    out: 'dist/ recriado em 1,8 s'
  },
  {
    parts: [
      { text: 'curl -fsSL https://exemplo.sh', verdict: 'ask', why: 'rede — perguntar' },
      { text: 'sh', verdict: 'deny', why: 'blacklist: executar script baixado' }
    ],
    sep: ['|'],
    outcome: 'deny',
    out: ''
  }
]

const CHIP: Record<Verdict, string> = {
  allow: 'border-success/30 bg-success/10 text-success',
  smart: 'border-accent/40 bg-accent-soft text-accent-strong',
  ask: 'border-warning/35 bg-warning/10 text-warning',
  deny: 'border-danger/35 bg-danger/10 text-danger'
}

type Done = { step: Step; result: 'ok' | 'denied' | 'blocked' }

export function ApprovalDemo() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const [i, setI] = useState(0)
  const [checked, setChecked] = useState(0) // quantos sub-comandos do passo atual já foram avaliados
  const [log, setLog] = useState<Done[]>([])
  const step = STEPS[i] as Step | undefined
  const evaluating = !!step && checked < step.parts.length
  const waiting = !!step && !evaluating && step.outcome === 'ask'

  // avalia um sub-comando por vez; resolve sozinho o que não precisa de você
  useEffect(() => {
    if (!inView || !step) return
    if (evaluating) {
      const id = setTimeout(() => setChecked((c) => c + 1), checked === 0 ? 700 : 520)
      return () => clearTimeout(id)
    }
    if (step.outcome === 'ask') return
    const id = setTimeout(
      () => {
        setLog((l) => [...l, { step, result: step.outcome === 'deny' ? 'blocked' : 'ok' }])
        setChecked(0)
        setI((n) => n + 1)
      },
      step.outcome === 'deny' ? 1400 : 650
    )
    return () => clearTimeout(id)
  }, [inView, step, evaluating, checked])

  const decide = (ok: boolean) => {
    if (!step) return
    setLog((l) => [...l, { step, result: ok ? 'ok' : 'denied' }])
    setChecked(0)
    setI((n) => n + 1)
  }
  const reset = () => {
    setLog([])
    setChecked(0)
    setI(0)
  }

  const cmd = (s: Step) =>
    s.parts.map((p, k) => (
      <span key={k}>
        {k > 0 && <span className="text-faint"> {s.sep[k - 1]} </span>}
        {p.text}
      </span>
    ))

  return (
    <div ref={ref} className="glass flex h-full flex-col overflow-hidden rounded-3xl">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[12px] text-subtle">
          <span className="size-2 rounded-full bg-accent shadow-[0_0_10px_rgb(139_92_246)]" />
          agente · shell
        </span>
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-subtle hover:bg-hover hover:text-fg"
        >
          <RotateCcw className="size-3" /> reiniciar
        </button>
      </div>
      <div className="flex-1 space-y-3 p-4 font-mono text-[12.5px] leading-relaxed">
        {log.map((d, k) => (
          <div key={k} className="animate-fade-in">
            <div className="flex items-start gap-2">
              {d.result === 'ok' ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : d.result === 'denied' ? (
                <X className="mt-0.5 size-3.5 shrink-0 text-warning" />
              ) : (
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
              )}
              <span
                className={cx(
                  'break-all',
                  d.result === 'ok' ? 'text-muted' : 'text-subtle line-through'
                )}
              >
                {cmd(d.step)}
              </span>
            </div>
            {d.result === 'ok' && d.step.out && (
              <p className="ml-5.5 text-[11.5px] text-faint">{d.step.out}</p>
            )}
            {d.result === 'denied' && (
              <p className="ml-5.5 text-[11.5px] text-warning/80">
                negado por você — o agente recebe o motivo
              </p>
            )}
            {d.result === 'blocked' && (
              <p className="ml-5.5 text-[11.5px] text-danger/90">
                bloqueado pela blacklist antes de rodar
              </p>
            )}
          </div>
        ))}

        {step && (
          <div
            key={i}
            className={cx(
              'animate-pop-in rounded-xl border p-3',
              waiting ? 'border-warning/40 bg-warning/[0.04]' : 'border-border-strong bg-bg/60'
            )}
          >
            <div className="flex items-start gap-2">
              <span className="text-accent-strong">$</span>
              <span className="break-all text-fg">{cmd(step)}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {step.parts.map((p, k) => (
                <span
                  key={k}
                  title={p.why}
                  className={cx(
                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-all duration-300',
                    k < checked ? CHIP[p.verdict] : 'border-border text-faint'
                  )}
                >
                  {k < checked ? (
                    p.verdict === 'allow' ? (
                      <ShieldCheck className="size-3" />
                    ) : p.verdict === 'smart' ? (
                      <Sparkles className="size-3" />
                    ) : p.verdict === 'deny' ? (
                      <ShieldAlert className="size-3" />
                    ) : (
                      <span>?</span>
                    )
                  ) : (
                    <span className="size-2 animate-pulse-soft rounded-full bg-faint" />
                  )}
                  {p.text.split(' ')[0]}
                  {k < checked && <span className="opacity-75">· {p.why}</span>}
                </span>
              ))}
            </div>
            {waiting && (
              <div className="mt-3 flex flex-wrap items-center gap-2 font-sans">
                <span className="mr-auto text-[12.5px] text-warning">
                  O agente quer rodar isto.
                </span>
                <button
                  type="button"
                  onClick={() => decide(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg"
                >
                  Negar
                </button>
                <button
                  type="button"
                  onClick={() => decide(true)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white shadow-[0_8px_24px_-10px_rgb(139_92_246)] hover:bg-[#9a70f8]"
                >
                  Permitir uma vez
                </button>
              </div>
            )}
          </div>
        )}
        {!step && (
          <button
            type="button"
            onClick={reset}
            className="w-full animate-fade-in rounded-xl border border-dashed border-border py-3 font-sans text-[12.5px] text-subtle hover:border-accent/40 hover:text-fg"
          >
            Ver de novo
          </button>
        )}
      </div>
    </div>
  )
}
