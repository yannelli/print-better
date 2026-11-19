import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface Choice<T extends string> {
  value: T
  label: string
}

/** A labelled single-choice dropdown; `items` lets the trigger show the label instead of the raw value. */
export function ChoiceSelect<T extends string>({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  id?: string
  value: T
  onChange: (value: T) => void
  options: Choice<T>[]
  disabled?: boolean
  className?: string
}) {
  return (
    <Select items={options} value={value} onValueChange={(next) => next !== null && onChange(next as T)} disabled={disabled}>
      <SelectTrigger id={id} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
