// Chamada simulada no hero: as falas aparecem como legenda ao vivo e, enquanto o "agente" fala,
// a amplitude vai para o orb (que pulsa junto).
import { type RefObject, useEffect, useState } from 'react'
import { AudioLines, Mic, PhoneOff, Terminal } from 'lucide-react'
import { cx } from '../../components/ui'
import { prefersReducedMotion } from './hooks'

type Line = { who: 'you' | 'agent'; text: string; tag?: { icon: 'tool' | 'filler'; label: string } }

const SCRIPT: Line[] = [
  { who: 'you', text: 'Ei, o build do site quebrou de novo?' },
  {
    who: 'agent',
    text: 'Hmm, deixa eu ver aqui…',
    tag: { icon: 'filler', label: 'interjeição enquanto pensa' }
  },
  {
    who: 'agent',
    text: 'O Vite reclamou de um import que não existe mais. Quer que eu corrija?',
    tag: { icon: 'tool', label: 'shell · npm run build · aprovado' }
  },
  { who: 'you', text: 'Pode. E roda os testes depois.' },
  {
    who: 'agent',
    text: 'Feito — corrigi o import e os testes passaram. O diff está no chat.',
    tag: { icon: 'tool', label: 'edit_file + shell · npm test' }
  }
]

function mmss(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function CallTicker({ amp, className }: { amp: RefObject<number>; className?: string }) {
  const [idx, setIdx] = useState(0)
  const [chars, setChars] = useState(0)
  const [secs, setSecs] = useState(37)
  const line = SCRIPT[idx % SCRIPT.length]

  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // digita a fala; ao terminar, pausa e passa para a próxima
  useEffect(() => {
    const reduced = prefersReducedMotion()
    if (reduced) {
      queueMicrotask(() => setChars(line.text.length))
      const id = setTimeout(() => setIdx((i) => i + 1), 4200)
      return () => clearTimeout(id)
    }
    let c = 0
    let t0 = 0
    let raf = 0
    let done: ReturnType<typeof setTimeout> | undefined
    const cps = line.who === 'agent' ? 26 : 32
    const tick = (now: number) => {
      if (!t0) t0 = now
      c = Math.min(line.text.length, Math.floor(((now - t0) / 1000) * cps))
      setChars(c)
      // voz do agente: envelope de "sílabas" (rápido) modulado por "palavras" (lento)
      if (line.who === 'agent') {
        const t = now / 1000
        const syl = Math.abs(Math.sin(t * 11.3)) * 0.6 + Math.abs(Math.sin(t * 4.1 + 1.3)) * 0.4
        const word = line.text[c] === ' ' || line.text[c] === ',' ? 0.35 : 1
        amp.current = 0.25 + 0.75 * syl * word
      } else amp.current = 0.06
      if (c < line.text.length) raf = requestAnimationFrame(tick)
      else {
        amp.current = 0
        done = setTimeout(() => setIdx((i) => i + 1), line.who === 'agent' ? 1700 : 900)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(done)
      amp.current = 0
    }
  }, [idx, line, amp])

  const prev = idx > 0 ? SCRIPT[(idx - 1) % SCRIPT.length] : null
  const speaking = line.who === 'agent' && chars < line.text.length
  return (
    <div
      className={cx(
        'glass w-full max-w-md rounded-2xl p-4 text-left shadow-[0_30px_80px_-30px_rgb(0_0_0/0.8)]',
        className
      )}
      aria-label="Exemplo de chamada de voz com o agente"
    >
      <div className="flex items-center justify-between text-[12px] text-subtle">
        <span className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          Chamada com <span className="text-muted">Agente</span>
          <span className="font-mono tabular-nums">{mmss(secs)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="flex size-6 items-center justify-center rounded-full bg-hover text-muted">
            <Mic className="size-3.5" />
          </span>
          <span className="flex size-6 items-center justify-center rounded-full bg-danger/15 text-danger">
            <PhoneOff className="size-3.5" />
          </span>
        </span>
      </div>
      <div className="mt-3 min-h-[118px] space-y-2.5 text-[14px] leading-snug" aria-live="off">
        {prev && (
          <p className="line-clamp-2 text-subtle transition-opacity">
            <span className="mr-1.5 font-medium">{prev.who === 'you' ? 'Você' : 'Agente'}:</span>
            {prev.text}
          </p>
        )}
        <p className={line.who === 'agent' ? 'text-fg' : 'text-muted'}>
          <span
            className={cx(
              'mr-1.5 font-medium',
              line.who === 'agent' ? 'text-accent-strong' : 'text-muted'
            )}
          >
            {line.who === 'you' ? 'Você' : 'Agente'}:
          </span>
          {line.text.slice(0, chars)}
          <span className="caret" aria-hidden />
        </p>
        {line.tag && chars >= line.text.length * 0.4 && (
          <span className="inline-flex animate-pop-in items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 font-mono text-[11px] text-accent-strong">
            {line.tag.icon === 'tool' ? (
              <Terminal className="size-3" />
            ) : (
              <AudioLines className="size-3" />
            )}
            {line.tag.label}
          </span>
        )}
      </div>
      <div className="mt-3 flex h-6 items-end gap-[3px]" aria-hidden>
        {Array.from({ length: 36 }, (_, i) => (
          <span
            key={i}
            className={cx(
              'eq-bar flex-1 rounded-full',
              speaking ? 'bg-accent-strong' : 'bg-border-strong'
            )}
            style={{
              animationDelay: `${(i * 97) % 900}ms`,
              animationPlayState: speaking ? 'running' : 'paused'
            }}
          />
        ))}
      </div>
    </div>
  )
}
