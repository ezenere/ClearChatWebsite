// Laboratório de voz: o movimento do cursor (ou do dedo) é a "sua voz". Parou de falar, o turno
// fecha e o pipeline da chamada acende etapa por etapa; mexeu enquanto o agente fala, ele para
// (barge-in) e volta a ouvir.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Brain, Ear, Mic, Volume2 } from 'lucide-react'
import { cx } from '../../components/ui'
import { useInView } from './hooks'

type Stage = 'idle' | 'listening' | 'stt' | 'llm' | 'filler' | 'speaking' | 'barge'

const CAPTION: Record<Stage, string> = {
  idle: 'Mexa o mouse (ou arraste o dedo) aqui dentro — é a sua voz.',
  listening: 'Ouvindo… a transcrição já começa enquanto você fala.',
  stt: 'Silêncio detectado: fim de turno adaptativo.',
  llm: 'O modelo responde em streaming…',
  filler: '“Hmm, deixa eu ver aqui…” — uma interjeição enquanto ele pensa.',
  speaking: 'A voz sai frase a frase, antes da resposta terminar.',
  barge: 'Você interrompeu: o agente para de falar na hora.'
}

const NODES: { id: string; label: string; icon: typeof Mic; on: Stage[] }[] = [
  { id: 'mic', label: 'Você', icon: Mic, on: ['listening', 'barge'] },
  { id: 'stt', label: 'Transcrição', icon: Ear, on: ['listening', 'stt'] },
  { id: 'llm', label: 'Modelo', icon: Brain, on: ['llm', 'filler', 'speaking'] },
  { id: 'tts', label: 'Voz', icon: AudioLines, on: ['filler', 'speaking'] },
  { id: 'out', label: 'Você ouve', icon: Volume2, on: ['filler', 'speaking'] }
]

const BARS = 96

export function VoiceLab() {
  const [wrapRef, inView] = useInView<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stage, setStage] = useState<Stage>('idle')
  // estado por quadro (fora do React)
  const sim = useRef({ energy: 0, lastMove: 0, px: 0, py: 0, stage: 'idle' as Stage, since: 0 })

  const go = useCallback((s: Stage) => {
    sim.current.stage = s
    sim.current.since = performance.now()
    setStage(s)
  }, [])

  const feed = (x: number, y: number) => {
    const s = sim.current
    const d = Math.hypot(x - s.px, y - s.py)
    s.px = x
    s.py = y
    if (d > 60) return // salto (entrou na área): não é "fala"
    s.energy = Math.min(1, s.energy + d / 90)
    s.lastMove = performance.now()
    if (d > 2 && (s.stage === 'idle' || s.stage === 'stt' || s.stage === 'llm')) go('listening')
    else if (d > 4 && (s.stage === 'filler' || s.stage === 'speaking')) go('barge')
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !inView) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const fit = () => {
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)
    const levels = new Float32Array(BARS)
    let raf = 0
    let agent = 0
    const frame = (now: number) => {
      const s = sim.current
      const t = now / 1000
      const elapsed = now - s.since
      s.energy *= 0.92
      // máquina de turnos da demonstração
      if (s.stage === 'listening' && now - s.lastMove > 650) go('stt')
      else if (s.stage === 'stt' && elapsed > 650) go('llm')
      else if (s.stage === 'llm' && elapsed > 700) go('filler')
      else if (s.stage === 'filler' && elapsed > 1500) go('speaking')
      else if (s.stage === 'speaking' && elapsed > 3200) go('idle')
      else if (s.stage === 'barge' && now - s.lastMove > 120) go('listening')

      const agentTalking = s.stage === 'filler' || s.stage === 'speaking'
      const want = agentTalking
        ? 0.35 + 0.45 * Math.abs(Math.sin(t * 9.7)) * (0.6 + 0.4 * Math.sin(t * 2.3))
        : 0
      agent += (want - agent) * 0.2

      const W = canvas.width
      const H = canvas.height
      const cx0 = W / 2
      const cy0 = H / 2
      const base = Math.min(W, H) * 0.24
      ctx.clearRect(0, 0, W, H)

      // halo
      const glow = ctx.createRadialGradient(cx0, cy0, base * 0.2, cx0, cy0, base * 2.2)
      const hue = agentTalking ? '167,139,250' : '103,232,249'
      glow.addColorStop(0, `rgba(${hue},${0.1 + Math.max(s.energy, agent) * 0.25})`)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, W, H)

      // barras radiais: ciano = você, violeta = agente
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2
        const n =
          0.5 +
          0.5 * Math.sin(i * 0.9 + t * 7) * Math.sin(i * 0.37 - t * 3.1) +
          0.25 * Math.sin(i * 2.3 + t * 13)
        const target = s.energy * 0.9 * n + agent * 0.85 * (0.5 + 0.5 * Math.sin(i * 0.5 + t * 10))
        levels[i] += (target - levels[i]) * 0.3
        const len = 3 * dpr + levels[i] * base * 0.95
        const r0 = base * 1.08
        ctx.strokeStyle = agentTalking
          ? `rgba(167,139,250,${0.35 + levels[i] * 0.65})`
          : `rgba(103,232,249,${0.25 + levels[i] * 0.75})`
        ctx.lineWidth = Math.max(1.5, ((Math.PI * 2 * r0) / BARS) * 0.42)
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(cx0 + Math.cos(a) * r0, cy0 + Math.sin(a) * r0)
        ctx.lineTo(cx0 + Math.cos(a) * (r0 + len), cy0 + Math.sin(a) * (r0 + len))
        ctx.stroke()
      }
      // núcleo
      const core = ctx.createRadialGradient(cx0 - base * 0.3, cy0 - base * 0.35, 0, cx0, cy0, base)
      core.addColorStop(0, agentTalking ? '#d8ccff' : '#c8f6ff')
      core.addColorStop(0.5, agentTalking ? '#8b5cf6' : '#38bdf8')
      core.addColorStop(1, agentTalking ? '#3b1f9e' : '#0c3a5a')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx0, cy0, base * (0.92 + Math.max(s.energy, agent) * 0.08), 0, Math.PI * 2)
      ctx.fill()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [inView, go])

  // teclado/sem mouse: um "falar" simulado
  const speak = () => {
    const s = sim.current
    let k = 0
    const id = setInterval(() => {
      feed(s.px + 20 * Math.cos(k), s.py + 20 * Math.sin(k))
      k += 0.9
      if (k > 14) clearInterval(id)
    }, 40)
  }

  return (
    <div ref={wrapRef} className="glass relative overflow-hidden rounded-3xl p-4 sm:p-6">
      <div
        className="relative aspect-square w-full touch-none select-none sm:aspect-[4/3]"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          feed(e.clientX - r.left, e.clientY - r.top)
        }}
        onPointerEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          sim.current.px = e.clientX - r.left
          sim.current.py = e.clientY - r.top
        }}
      >
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />
        <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center">
          <p
            key={stage}
            className="mx-auto max-w-sm animate-slide-up px-4 text-[13.5px] text-muted"
            aria-live="polite"
          >
            {CAPTION[stage]}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-1.5 sm:gap-2">
        {NODES.map((n) => {
          const on = n.on.includes(stage)
          const Icon = n.icon
          return (
            <div
              key={n.id}
              className={cx(
                'flex flex-col items-center gap-1.5 rounded-xl border px-1 py-2.5 text-center text-[11px] transition-all duration-300 sm:text-[12px]',
                on
                  ? 'border-accent/50 bg-accent-soft text-fg shadow-[0_0_24px_-6px_rgb(139_92_246/0.7)]'
                  : 'border-border bg-bg/40 text-subtle'
              )}
            >
              <Icon className={cx('size-4', on && 'text-accent-strong')} />
              {n.label}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={speak}
        className="mt-3 w-full rounded-lg border border-border py-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg sm:sr-only"
      >
        Simular uma fala
      </button>
    </div>
  )
}
