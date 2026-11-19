import type { Job } from '@shared/types'
import { formatAmount, formatMicros } from '@shared/usage-text'
import type { SlotProps } from '../registry'
import { usePrices } from './hooks'

/** Pages are left out once the device reported them, since the job already shows those. */
function usageLine(job: Job, currency: string): string | null {
  const u = job.usage
  if (!u) return null
  const parts = [...(job.pages == null ? [formatAmount('pages', u.pages, currency)] : []), formatAmount('sheets', u.sheets, currency)]
  if (u.costMicros > 0) parts.push(formatMicros(u.costMicros, currency))
  const line = parts.join(', ')
  return u.estimated ? `About ${line}` : line.charAt(0).toUpperCase() + line.slice(1)
}

/** Under a job in Print jobs: its pages and cost, and what rules and limits did to it. */
export default function JobMeta({ ws, job }: SlotProps['jobMeta']) {
  const currency = usePrices(ws).data?.currency
  const notes = job.policy?.notes ?? []
  const usage = currency ? usageLine(job, currency) : null
  if (!usage && notes.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5 text-sm whitespace-normal text-muted-foreground">
      {usage && <span>{usage}</span>}
      {notes.map((note, i) => (
        <span key={i}>
          {note.name}: {note.message}
        </span>
      ))}
    </div>
  )
}
