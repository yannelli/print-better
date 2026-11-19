import type { SlotProps } from '../registry'
import { useCostCenters } from './hooks'

/** Under a job in Print jobs: the cost center it is charged to. */
export default function CostCenterMeta({ ws, job }: SlotProps['jobMeta']) {
  const centers = useCostCenters(ws, !!job.costCenterId).data?.costCenters
  const center = job.costCenterId ? centers?.find((c) => c.id === job.costCenterId) : undefined
  if (!center) return null
  return <span className="text-sm whitespace-normal text-muted-foreground">Charged to {center.name}</span>
}
