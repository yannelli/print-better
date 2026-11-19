import { Printer as PrinterIcon } from 'lucide-react'
import { Link } from 'wouter'
import type { Printer } from '@shared/types'
import { useAppActions, wsHref } from '@/components/shell/app-actions'
import { StatusPill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { printerStatus } from '@/lib/words'
import { Supplies } from './supplies'

export function printerPlace(printer: Printer) {
  return printer.location ? `${printer.location}, via ${printer.clientName}` : `Connected to ${printer.clientName}`
}

/** The whole card opens the printer; the Print button sits above the stretched link. */
export function PrinterCard({ ws, printer }: { ws: string; printer: Printer }) {
  const { openPrint } = useAppActions()
  const status = printerStatus(printer)
  return (
    <article className="relative flex flex-col gap-4 rounded-3xl border bg-card p-5 transition-colors hover:border-input">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <PrinterIcon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate text-lg font-semibold tracking-tight">
            <Link href={wsHref(ws, `/printers/${printer.id}`)} className="rounded-sm after:absolute after:inset-0 after:rounded-3xl">
              {printer.name}
            </Link>
          </h3>
          <p className="truncate text-sm text-muted-foreground">{printerPlace(printer)}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <StatusPill status={status} />
        {status.detail && <p className="text-sm text-muted-foreground">{status.detail}</p>}
      </div>
      <Supplies supplies={printer.status.supplies} compact limit={4} />
      <div className="relative z-10 mt-auto flex">
        <Button variant="tonal" onClick={() => openPrint({ printerId: printer.id })} aria-label={`Print on ${printer.name}`}>
          Print
        </Button>
      </div>
    </article>
  )
}
