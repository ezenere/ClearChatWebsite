// Efeitos da landing: revelar ao rolar, cartões com holofote, inclinação 3D, texto que "decifra",
// letreiro infinito e o brilho que segue o cursor.
import {
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react'
import { cx } from '../../components/ui'
import { prefersReducedMotion, useInView } from './hooks'

function setSpot(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  el.style.setProperty('--sx', `${e.clientX - r.left}px`)
  el.style.setProperty('--sy', `${e.clientY - r.top}px`)
}

/** Cartão com holofote: um brilho e uma borda iluminada seguem o cursor. */
export function SpotCard({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} onPointerMove={setSpot} className={cx('spot', className)}>
      {children}
    </div>
  )
}

/** Inclina o conteúdo em 3D na direção do cursor, com um reflexo. */
export function Tilt({
  children,
  className,
  max = 7
}: {
  children: ReactNode
  className?: string
  max?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || prefersReducedMotion()) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--rx', `${(-y * max).toFixed(2)}deg`)
    el.style.setProperty('--ry', `${(x * max).toFixed(2)}deg`)
    el.style.setProperty('--gx', `${(x + 0.5) * 100}%`)
    el.style.setProperty('--gy', `${(y + 0.5) * 100}%`)
    el.dataset.tilting = ''
  }
  const onLeave = () => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
    delete el.dataset.tilting
  }
  return (
    <div className={cx('tilt-wrap', className)} onPointerMove={onMove} onPointerLeave={onLeave}>
      <div ref={ref} className="tilt">
        {children}
        <div aria-hidden className="tilt-glare" />
      </div>
    </div>
  )
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-'

/**
 * Mostra `text`, mas sempre que ele muda (ou ao entrar na tela) os caracteres passam por
 * símbolos aleatórios antes de assentar — o efeito de "decifrar".
 */
export function Scramble({
  text,
  className,
  speed = 1,
  style
}: {
  text: string
  className?: string
  speed?: number
  style?: CSSProperties
}) {
  const [shown, setShown] = useState(text)
  const [ref, inView] = useInView<HTMLSpanElement>(true)
  useEffect(() => {
    if (!inView || prefersReducedMotion()) {
      queueMicrotask(() => setShown(text))
      return
    }
    let frame = 0
    let raf = 0
    const total = Math.min(28, 10 + text.length / 6) / speed
    const tick = () => {
      frame++
      const done = frame / total
      let s = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === ' ' || ch === '\n' || i / text.length < done) s += ch
        else s += GLYPHS[(Math.random() * GLYPHS.length) | 0]
      }
      setShown(s)
      if (done < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, inView, speed])
  return (
    <span ref={ref} className={className} style={style}>
      {shown}
    </span>
  )
}

/** Faixa que rola sem fim (pausa no hover); o conteúdo é duplicado para emendar. */
export function Marquee({ items, className }: { items: string[]; className?: string }) {
  const row = (hidden: boolean) => (
    <ul className="marquee-row" aria-hidden={hidden || undefined}>
      {items.map((t) => (
        <li key={t} className="flex items-center gap-10">
          <span>{t}</span>
          <span aria-hidden className="size-1 rounded-full bg-accent/60" />
        </li>
      ))}
    </ul>
  )
  return (
    <div className={cx('marquee', className)}>
      {row(false)}
      {row(true)}
    </div>
  )
}

/** Brilho violeta grande que acompanha o cursor pela página (só com mouse). */
export function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!matchMedia('(pointer: fine)').matches || prefersReducedMotion()) return
    const el = ref.current
    if (!el) return
    let x = innerWidth / 2
    let y = innerHeight / 3
    let tx = x
    let ty = y
    let raf = 0
    const tick = () => {
      x += (tx - x) * 0.12
      y += (ty - y) * 0.12
      el.style.transform = `translate3d(${x - 300}px, ${y - 300}px, 0)`
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(tick) : 0
    }
    const onMove = (e: globalThis.PointerEvent) => {
      tx = e.clientX
      ty = e.clientY
      el.style.opacity = '1'
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onOut = () => (el.style.opacity = '0')
    addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onOut)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onOut)
    }
  }, [])
  return <div ref={ref} aria-hidden className="cursor-glow" />
}

/** Número que conta até `to` quando aparece. */
export function CountUp({
  to,
  format = (n) => String(Math.round(n)),
  ms = 1400
}: {
  to: number
  format?: (n: number) => string
  ms?: number
}) {
  const [ref, inView] = useInView<HTMLSpanElement>(true)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!inView) return
    if (prefersReducedMotion()) {
      queueMicrotask(() => setN(to))
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      setN(to * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, to, ms])
  return <span ref={ref}>{format(n)}</span>
}
