import { Row, Section } from '@/components/page'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { enterpriseApi } from './api'
import { useCostCenters, useDefaults, useEnterpriseMutation } from './hooks'

const NONE = ''

/** A device's default cost center, for jobs from its print window that don't come with one. */
export default function DeviceCostCenter({ ws, client }: SlotProps['deviceSection']) {
  const centers = useCostCenters(ws).data?.costCenters
  const defaults = useDefaults(ws).data
  const set = useEnterpriseMutation(ws, (centerId: string) => enterpriseApi.setDefaults(ws, { devices: { [client.id]: centerId || null } }), 'Default saved')
  if (!centers || !defaults) return null
  const current = defaults.devices[client.id] ?? NONE
  const options = [
    { value: NONE, label: 'None' },
    ...centers.filter((c) => c.active || c.id === current).map((c) => ({ value: c.id, label: c.active ? c.name : `${c.name} (inactive)` })),
  ]
  return (
    <Section id="device-cost-center" title="Cost center" flush>
      <Row
        label="Charge its jobs to"
        htmlFor="device-cost-center-choice"
        description="For jobs from this device that don’t come with a cost center. A default set for one of its groups comes first."
      >
        <ChoiceSelect id="device-cost-center-choice" value={current} onChange={(next) => next !== current && set.mutate(next)} options={options} disabled={set.isPending} />
      </Row>
    </Section>
  )
}
