import { useId } from 'react'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { useCostCenters, useEnterprise } from './hooks'

const NONE = ''

/** Print dialog: which cost center the job is charged to, starting at the sender's default. */
export default function CostCenterPicker({ ws, extra, setExtra }: SlotProps['printForm']) {
  const id = useId()
  const list = useCostCenters(ws).data
  const required = useEnterprise(ws).data?.settings.costCenters.required ?? false
  if (!list) return null
  const active = list.costCenters.filter((c) => c.active)
  if (active.length === 0 && !required) return null
  const value = typeof extra.costCenter === 'string' ? extra.costCenter : (list.myDefault ?? NONE)
  const options = [
    ...(list.myDefault ? [] : [{ value: NONE, label: required ? 'Choose a cost center' : 'None' }]),
    ...active.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name })),
  ]
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-cost-center`}>Charge to</FieldLabel>
      <ChoiceSelect
        id={`${id}-cost-center`}
        value={value}
        onChange={(next) => setExtra({ costCenter: next === NONE ? undefined : next })}
        options={options}
        className="sm:w-full"
      />
      {active.length === 0 ? (
        <FieldDescription>Every job needs a cost center, and none are set up yet. Ask an admin to add one.</FieldDescription>
      ) : (
        list.myDefault && value === list.myDefault && <FieldDescription>Your default cost center.</FieldDescription>
      )}
    </Field>
  )
}
