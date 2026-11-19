import { useState } from 'react'
import type { PrintRequest } from '@/components/shell/app-actions'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { PrintForm } from './print-form'

/** Stays open while a file uploads; closing mid-upload would leave a half-sent job behind. */
export default function PrintDialog({
  ws,
  open,
  request,
  onOpenChange,
}: {
  ws: string
  open: boolean
  request: PrintRequest
  onOpenChange: (open: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl sm:p-8">
        <PrintForm ws={ws} request={request} onBusyChange={setBusy} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
