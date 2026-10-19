import type { Strength } from '../lib/password'
import { cx } from './ui'

const COLORS = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success/80', 'bg-success']
const TEXT = ['text-danger', 'text-danger', 'text-warning', 'text-success', 'text-success']

export function PasswordMeter({ strength, empty }: { strength: Strength; empty: boolean }) {
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cx(
              'h-1.5 flex-1 rounded-full transition-colors',
              !empty && strength.score > i ? COLORS[strength.score] : 'bg-active'
            )}
          />
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className={empty ? 'text-subtle' : TEXT[strength.score]}>
          {empty ? 'Força da senha' : `Força: ${strength.label}`}
        </span>
        {!empty && strength.hints[0] && (
          <span className="text-right text-subtle">{strength.hints[0]}</span>
        )}
      </div>
    </div>
  )
}
