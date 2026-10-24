// Hooks e utilidades de movimento da landing.
import { type RefObject, useEffect, useRef, useState } from 'react'

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Marca `data-in` nos `[data-reveal]` dentro de `root` quando entram na tela (uma vez). */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const items = el.querySelectorAll<HTMLElement>('[data-reveal]')
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      items.forEach((i) => (i.dataset.in = ''))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            ;(e.target as HTMLElement).dataset.in = ''
            io.unobserve(e.target)
          }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    )
    items.forEach((i) => io.observe(i))
    return () => io.disconnect()
  }, [root])
}

/** true quando o elemento está (ou já esteve) visível — dispara demos só quando alguém olha. */
export function useInView<T extends HTMLElement>(once = false) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setInView(true))
      return
    }
    const io = new IntersectionObserver(
      ([e]) => {
        setInView(e.isIntersecting)
        if (e.isIntersecting && once) io.disconnect()
      },
      { threshold: 0.25 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once])
  return [ref, inView] as const
}
