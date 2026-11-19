import type { Cycle, CycleKind } from '@shared/usage'
import { ChoiceSelect } from '@/routes/settings/fields'
import { CYCLE_KINDS, FIRST_CYCLE, MONTHS, WEEKDAYS } from './cycles'

const ALL = CYCLE_KINDS.map((k) => k.value)
const DAYS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `From day ${i + 1}` }))
const STARTS = MONTHS.map((month, i) => ({ value: String(i + 1), label: `From ${month}` }))
const FIRST_DAYS = WEEKDAYS.map((day, i) => ({ value: String(i), label: `From ${day}` }))

/** When usage starts over: how often, then the weekday, day of the month, or month it starts on. */
export function CycleField({
  id,
  value,
  onChange,
  kinds = ALL,
  disabled,
}: {
  id?: string
  value: Cycle
  onChange: (cycle: Cycle) => void
  kinds?: readonly CycleKind[]
  disabled?: boolean
}) {
  const start = (options: { value: string; label: string }[], current: number, make: (n: number) => Cycle) => (
    <ChoiceSelect ariaLabel="Starts" value={String(current)} onChange={(v) => onChange(make(Number(v)))} options={options} disabled={disabled} className="sm:w-48" />
  )
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <ChoiceSelect
        id={id}
        value={value.kind}
        onChange={(kind) => kind !== value.kind && onChange(FIRST_CYCLE[kind])}
        options={CYCLE_KINDS.filter((k) => kinds.includes(k.value))}
        disabled={disabled}
        className="sm:w-44"
      />
      {value.kind === 'week' && start(FIRST_DAYS, value.firstDay, (firstDay) => ({ kind: 'week', firstDay }))}
      {value.kind === 'month' && start(DAYS, value.startDay, (startDay) => ({ kind: 'month', startDay }))}
      {value.kind === 'quarter' && start(STARTS, value.startMonth, (startMonth) => ({ kind: 'quarter', startMonth }))}
      {value.kind === 'year' && start(STARTS, value.startMonth, (startMonth) => ({ kind: 'year', startMonth }))}
    </div>
  )
}
