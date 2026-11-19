import { Input } from '@/components/ui/input'

/** An amount in the workspace currency, typed as a plain decimal such as 0.05. */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  disabled,
  invalid,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  currency: string
  disabled?: boolean
  invalid?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className="tabular w-28"
      />
      <span className="text-muted-foreground">{currency}</span>
    </div>
  )
}
