import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** A whole (or decimal) number typed freely: `onChange` gets undefined while the text isn't one. */
export function NumberInput({ id, value, onChange, decimals, label, className }: {
  id?: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  decimals?: boolean
  label?: string
  className?: string
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const valid = (t: string) => (decimals ? /^\d{1,4}(\.\d{1,2})?$/ : /^\d{1,7}$/).test(t.trim())
  return (
    <Input
      id={id}
      aria-label={label}
      inputMode={decimals ? 'decimal' : 'numeric'}
      value={text}
      aria-invalid={(text !== '' && !valid(text)) || undefined}
      onChange={(e) => {
        setText(e.target.value)
        onChange(valid(e.target.value) ? Number(e.target.value.trim()) : undefined)
      }}
      className={cn('tabular w-24', className)}
    />
  )
}
