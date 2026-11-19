import type { SlotProps } from '../registry'
import { useAccessSummaries } from './hooks'
import { LAN_SHARE_WARNING, Note } from './note'

/** Local network sharing bypasses access control, so say so where it is switched on. */
export default function LanShareNote({ ws, printer }: SlotProps['printerSharingNote']) {
  const restricted = useAccessSummaries(ws).data?.find((s) => s.printerId === printer.id)?.restricted
  if (!restricted || !printer.settings.lanShare) return null
  return <Note tone="warn">{LAN_SHARE_WARNING}</Note>
}
