import type { Supply } from '@shared/types'
import { cn } from '@/lib/utils'

const NAMED: [RegExp, string][] = [
  [/cyan/i, '#00a3d9'],
  [/magenta/i, '#d4147a'],
  [/yellow/i, '#f2c200'],
  [/black|\bk\b/i, 'var(--foreground)'],
]

/** Toner swatches are real-world colors; black follows the theme so it stays visible in dark mode. */
export function supplyColor(supply: Supply): string {
  const hex = supply.color?.match(/^#?([0-9a-f]{6})$/i)?.[1]
  if (hex) {
    const n = parseInt(hex, 16)
    const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    return lum < 0.15 ? 'var(--foreground)' : `#${hex}`
  }
  const text = `${supply.color ?? ''} ${supply.name}`
  return NAMED.find(([re]) => re.test(text))?.[1] ?? 'var(--muted-foreground)'
}

const LOW = 15

function SupplyRow({ supply, compact }: { supply: Supply; compact?: boolean }) {
  const known = supply.level >= 0
  const level = Math.min(100, Math.max(0, supply.level))
  const low = known && level <= LOW
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate">{supply.name}</span>
        <span className={cn('tabular shrink-0', low ? 'font-medium text-on-warn-container' : 'text-muted-foreground')}>
          {known ? `${low ? 'Low, ' : ''}${level}%` : 'Level unknown'}
        </span>
      </div>
      <div
        role="meter"
        aria-label={supply.name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? level : undefined}
        aria-valuetext={known ? `${level} percent${low ? ', low' : ''}` : 'Level unknown'}
        className={cn('overflow-hidden rounded-full bg-muted', compact ? 'h-1.5' : 'h-2.5')}
      >
        {known && (
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-emphasized"
            style={{ width: `${Math.max(level, 2)}%`, background: supplyColor(supply) }}
          />
        )}
      </div>
    </li>
  )
}

export function Supplies({ supplies, compact, limit }: { supplies: Supply[]; compact?: boolean; limit?: number }) {
  const shown = limit ? supplies.slice(0, limit) : supplies
  if (shown.length === 0) return null
  return (
    <ul className={cn('grid gap-3', shown.length > 1 && (compact ? 'grid-cols-2' : 'sm:grid-cols-2'))} aria-label="Ink and toner">
      {shown.map((s, i) => (
        <SupplyRow key={`${s.name}-${i}`} supply={s} compact={compact} />
      ))}
    </ul>
  )
}
