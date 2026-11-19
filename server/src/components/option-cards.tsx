import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Option<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  /** Visual shown above or beside the label (icon, swatch, preview). */
  media?: ReactNode
  disabled?: boolean
}

/** Large tappable radio cards: one choice, all options visible, arrow keys move between them. */
export function OptionCards<T extends string>({
  value,
  onChange,
  options,
  label,
  columns = 3,
  layout = 'stack',
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  label: string
  columns?: 2 | 3 | 4
  layout?: 'stack' | 'inline'
  className?: string
}) {
  const cols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[columns]
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className={cn('grid gap-2', cols, className)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'press group/option relative flex min-h-14 cursor-pointer rounded-2xl border bg-card p-3.5 text-left outline-none',
            'hover:bg-muted data-checked:border-transparent data-checked:bg-brand-container data-checked:text-on-brand-container',
            'data-checked:ring-2 data-checked:ring-brand data-disabled:cursor-not-allowed data-disabled:opacity-50',
            layout === 'stack' ? 'flex-col items-start gap-2' : 'flex-row items-center gap-3',
          )}
        >
          {option.media && <span className="flex shrink-0 items-center [&_svg]:size-5">{option.media}</span>}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[0.9375rem] font-medium">{option.label}</span>
            {option.description && (
              <span className="text-sm text-muted-foreground group-data-checked/option:text-current/80">{option.description}</span>
            )}
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
