import { Link } from 'wouter'
import type { WorkspaceAccess } from '@shared/access'
import type { Printer } from '@shared/types'
import { Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { ErrorState, SkeletonRows } from '@/components/states'
import { StatusPill } from '@/components/status'
import { useDeviceAccess, useDevicePrintable } from '@/hooks/access'
import { useAddedPrinters } from '@/hooks/printers'
import { accessReason, devicePrintWords, thisComputer } from '@/lib/words'
import type { SlotProps } from '../registry'
import { useExplainMany, useSubjectSources, useWorkspaceAccess } from './hooks'
import { reasonNames } from './roles'

function PrinterRow({ ws, printer, allowed, why, where }: { ws: string; printer: Printer; allowed: boolean; why: string[]; where: string }) {
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{printer.name}</span>
        <span className="text-sm text-muted-foreground">
          {allowed ? why.join('. ') || `On ${printer.clientName}` : 'Nothing gives it access to this printer'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={devicePrintWords(allowed, where)} />
        <Link href={wsHref(ws, `/printers/${printer.id}/access`)} className="text-sm font-medium underline underline-offset-4">
          Change access
        </Link>
      </div>
    </li>
  )
}

/** Printers it can print to come first, each with the grants behind it, as in `/access/explain`. */
function Rows({ ws, client, printers, access }: { ws: string; client: SlotProps['deviceSection']['client']; printers: Printer[]; access: WorkspaceAccess }) {
  const sources = useSubjectSources(ws)
  const device = useDeviceAccess(ws, client.id)
  const printable = useDevicePrintable(ws, client.id)
  const allowed = printable ? printers.filter((p) => printable(p.id)) : []
  const results = useExplainMany(ws, allowed.map((p) => p.id), { type: 'client', id: client.id })
  const failed = device.error ? device : results.find((r) => r.error)
  if (failed) return <ErrorState error={failed.error} onRetry={() => failed.refetch()} className="m-4" />
  if (!printable || results.some((r) => !r.data)) return <SkeletonRows rows={Math.min(printers.length, 3)} className="p-4" />
  const names = reasonNames(access, sources)
  const why = new Map(allowed.map((p, i) => [p.id, results[i].data!.sources.map((s) => accessReason(s, names))]))
  const ordered = [...allowed, ...printers.filter((p) => !printable(p.id))]
  return (
    <ul>
      {ordered.map((p) => (
        <PrinterRow key={p.id} ws={ws} printer={p} allowed={printable(p.id)} why={why.get(p.id) ?? []} where={thisComputer(client)} />
      ))}
    </ul>
  )
}

export default function DevicePrinterAccess({ ws, client }: SlotProps['deviceSection']) {
  const access = useWorkspaceAccess(ws)
  const printers = (useAddedPrinters(ws).data ?? []).filter((p) => p.clientId !== client.id)
  return (
    <Section
      id="device-access"
      title="Printer access"
      description={`What ${client.name} can print to through Print Better. Its print window shows only the printers it can print to.`}
      flush
    >
      {printers.length === 0 ? (
        <p className="px-5 py-6 text-muted-foreground sm:px-6">There are no printers on other devices yet.</p>
      ) : access.data ? (
        <Rows ws={ws} client={client} printers={printers} access={access.data} />
      ) : access.error ? (
        <ErrorState error={access.error} onRetry={() => access.refetch()} className="m-4" />
      ) : (
        <SkeletonRows rows={2} className="p-4" />
      )}
    </Section>
  )
}
