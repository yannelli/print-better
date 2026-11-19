import { ShieldCheck, Unlock } from 'lucide-react'
import type { SlotProps } from '../registry'
import { useEnterprise } from './hooks'

const badge = 'inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-muted px-3 text-sm font-medium whitespace-nowrap text-muted-foreground'

/** "Needs approval" and "Release at printer" beside printers that use them. */
export default function ControlsBadge({ ws, printer }: SlotProps['printerBadge']) {
  const config = useEnterprise(ws).data
  const controls = config?.printers[printer.id]
  if (!config || !controls) return null
  return (
    <>
      {controls.approval && config.settings.approvals.enabled && (
        <span title="Every job on this printer waits for approval" className={badge}>
          <ShieldCheck aria-hidden className="size-3.5" />
          Needs approval
        </span>
      )}
      {controls.secureRelease && config.settings.release.enabled && (
        <span title="Jobs wait until their sender releases them" className={badge}>
          <Unlock aria-hidden className="size-3.5" />
          Release at printer
        </span>
      )}
    </>
  )
}
