// Avisos temporários (canto inferior).
import { create } from 'zustand'
import { CheckCircle2, XCircle, Info } from 'lucide-react'
import { cx } from './ui'

interface Toast {
  id: number
  tone: 'success' | 'error' | 'info'
  text: string
}
const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }))
let n = 0

export function toast(text: string, tone: Toast['tone'] = 'success'): void {
  const id = ++n
  useToasts.setState((s) => ({ list: [...s.list, { id, tone, text }] }))
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), 4200)
}

export function Toaster() {
  const list = useToasts((s) => s.list)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {list.map((t) => {
        const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex max-w-md animate-slide-up items-center gap-2.5 rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm shadow-popover"
          >
            <Icon
              className={cx(
                'size-4 shrink-0',
                t.tone === 'success' && 'text-success',
                t.tone === 'error' && 'text-danger',
                t.tone === 'info' && 'text-accent-strong'
              )}
            />
            {t.text}
          </div>
        )
      })}
    </div>
  )
}
