import { Lock } from 'lucide-react'
import type { SlotProps } from '../registry'
import { useAccessSummaries } from './hooks'

/** "Restricted" when Everyone has no access, so only owners, admins, and grants can use the printer. */
export default function RestrictedBadge({ ws, printer }: SlotProps['printerBadge']) {
  const summary = useAccessSummaries(ws).data?.find((s) => s.printerId === printer.id)
  if (!summary?.restricted) return null
  return (
    <span
      title="Only some people can use this printer"
      className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-muted px-3 text-sm font-medium whitespace-nowrap text-muted-foreground"
    >
      <Lock aria-hidden className="size-3.5" />
      Restricted
    </span>
  )
}
