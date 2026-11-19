import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular transition-colors duration-300',
                done && 'bg-brand text-brand-foreground',
                active && 'bg-brand-container text-on-brand-container ring-2 ring-brand',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <Check className="size-4" strokeWidth={3} aria-hidden /> : i + 1}
            </span>
            <span className={cn('text-sm', active ? 'font-semibold text-foreground' : 'text-muted-foreground', !active && 'max-sm:sr-only')}>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </li>
        )
      })}
    </ol>
  )
}

/** Numbered instructions: these are a real sequence, so the numbers carry meaning. */
export function NumberedSteps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {children.map((child, i) => (
        <li key={i} className="flex gap-4">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular text-muted-foreground"
          >
            {i + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1 text-base">{child}</div>
        </li>
      ))}
    </ol>
  )
}

export function StepHeading({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description && <p className="max-w-prose text-base text-muted-foreground">{description}</p>}
    </div>
  )
}
