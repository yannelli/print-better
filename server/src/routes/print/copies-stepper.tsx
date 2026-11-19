import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CopiesStepper({
  id,
  value,
  max,
  onChange,
  disabled,
}: {
  id: string
  value: number
  max: number
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const limit = max > 0 ? max : 99
  const set = (n: number) => onChange(Math.min(limit, Math.max(1, Math.round(n) || 1)))
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="icon" aria-label="One fewer copy" onClick={() => set(value - 1)} disabled={disabled || value <= 1}>
        <Minus />
      </Button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={limit}
        value={value}
        disabled={disabled}
        onChange={(e) => set(Number(e.target.value))}
        className="tabular h-11 w-16 rounded-2xl border border-input bg-background text-center text-lg font-medium outline-none [appearance:textfield] focus-visible:border-ring [&::-webkit-inner-spin-button]:appearance-none"
      />
      <Button type="button" variant="outline" size="icon" aria-label="One more copy" onClick={() => set(value + 1)} disabled={disabled || value >= limit}>
        <Plus />
      </Button>
    </div>
  )
}
