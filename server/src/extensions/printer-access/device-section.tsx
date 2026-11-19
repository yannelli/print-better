import { Link } from 'wouter'
import type { AccessExplanation, WorkspaceAccess } from '@shared/access'
import type { Printer } from '@shared/types'
import { Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { ErrorState, SkeletonRows } from '@/components/states'
import { StatusPill } from '@/components/status'
import { useAddedPrinters } from '@/hooks/printers'
import { accessReason, devicePrintWords, type ReasonNames } from '@/lib/words'
import type { SlotProps } from '../registry'
import { useExplainMany, useSubjectSources, useWorkspaceAccess } from './hooks'
import { reasonNames } from './roles'

function PrinterRow({ ws, printer, explanation, names }: { ws: string; printer: Printer; explanation: AccessExplanation; names: ReasonNames }) {
  const words = devicePrintWords(explanation.permissions)
  const why = explanation.sources.map((s) => accessReason(s, names))
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{printer.name}</span>
        <span className="text-sm text-muted-foreground">{why.length ? why.join('. ') : 'Nothing gives it access to this printer'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={words} />
        <Link href={wsHref(ws, `/printers/${printer.id}/access`)} className="text-sm font-medium underline underline-offset-4 hover:text-foreground">
          Change access
        </Link>
      </div>
    </li>
  )
}

function Rows({ ws, clientId, printers, access }: { ws: string; clientId: string; printers: Printer[]; access: WorkspaceAccess }) {
  const sources = useSubjectSources(ws)
  const results = useExplainMany(ws, printers.map((p) => p.id), { type: 'client', id: clientId })
  const failed = results.find((r) => r.error)
  if (failed) return <ErrorState error={failed.error} onRetry={() => failed.refetch()} className="m-4" />
  if (results.some((r) => !r.data)) return <SkeletonRows rows={Math.min(printers.length, 3)} className="p-4" />
  const names = reasonNames(access, sources)
  return (
    <ul>
      {printers.map((p, i) => (
        <PrinterRow key={p.id} ws={ws} printer={p} explanation={results[i].data!} names={names} />
      ))}
    </ul>
  )
}

/** Which printers appear in this device's print window, and the grants behind each. */
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
        <Rows ws={ws} clientId={client.id} printers={printers} access={access.data} />
      ) : access.error ? (
        <ErrorState error={access.error} onRetry={() => access.refetch()} className="m-4" />
      ) : (
        <SkeletonRows rows={2} className="p-4" />
      )}
    </Section>
  )
}
