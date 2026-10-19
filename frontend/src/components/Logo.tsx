// Ícone do app (squircle violeta + balão), versão compacta do build/icon.svg do ClearChat.
import { useId } from 'react'
import { cx } from './ui'

export function AppIcon({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 24 24" className={cx('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={`bg${id}`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b39dfc" />
          <stop offset="0.45" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4c32c4" />
        </linearGradient>
        <radialGradient id={`gl${id}`} cx="8.6" cy="2.3" r="14.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`bb${id}`} x1="0" y1="5" x2="0" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#ece6ff" />
        </linearGradient>
      </defs>
      <rect x="2.35" y="2.35" width="19.3" height="19.3" rx="5.6" fill={`url(#bg${id})`} />
      <rect x="2.35" y="2.35" width="19.3" height="19.3" rx="5.6" fill={`url(#gl${id})`} />
      <g transform="translate(2.74 2.96) scale(0.772)">
        <path
          d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-3.6 2.7a.6.6 0 0 1-.96-.48V16A2.5 2.5 0 0 1 5 13.5v-6Z"
          fill={`url(#bb${id})`}
        />
        <path d="M9 10.5h6" stroke="#7c55ea" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  )
}

export function Wordmark({ name = 'ClearChat', className }: { name?: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <AppIcon className="size-8" />
      <span className="text-[17px] font-semibold tracking-tight text-fg">{name}</span>
    </span>
  )
}
