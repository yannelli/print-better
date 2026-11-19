import { Checkbox } from '@/components/ui/checkbox'

/** Several choices as checkboxes in a row that wraps. */
export function CheckList<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]
  value: readonly T[]
  onChange: (value: T[]) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm has-[[data-checked]]:border-primary has-[[data-checked]]:bg-brand-container">
          <Checkbox
            checked={value.includes(o.value)}
            onCheckedChange={(on) => onChange(on ? [...value, o.value] : value.filter((v) => v !== o.value))}
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}
