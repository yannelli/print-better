import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import type { Printer } from '@shared/types'
import { Section } from '@/components/page'
import { toneContainer } from '@/components/status'
import { cn } from '@/lib/utils'
import { printerProblems, printerStatus } from '@/lib/words'
import { Supplies } from './supplies'

export function PrinterStatusSection({ printer }: { printer: Printer }) {
  const status = printerStatus(printer)
  const problems = printer.clientOnline ? printerProblems(printer) : []
  const healthy = printer.clientOnline && problems.length === 0 && status.tone === 'ok'
  return (
    <Section title="Status" id="status">
      <div className="flex flex-col gap-6" aria-live="polite">
        {healthy ? (
          <p className="flex items-center gap-3 text-base">
            <CircleCheck className="size-5 shrink-0 text-ok" />
            Everything looks good. This printer is ready.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {!printer.clientOnline && (
              <li className={cn('flex items-start gap-3 rounded-2xl px-4 py-3', toneContainer('neutral'))}>
                <CircleAlert className="mt-0.5 size-5 shrink-0" />
                <span>
                  {printer.clientName} is offline. Turn it on and make sure it has internet. Print jobs wait until it is back.
                </span>
              </li>
            )}
            {problems.map((p) => (
              <li key={p.text} className={cn('flex items-start gap-3 rounded-2xl px-4 py-3', toneContainer(p.tone))}>
                <TriangleAlert className="mt-0.5 size-5 shrink-0" />
                <span className="font-medium">{p.text}</span>
              </li>
            ))}
            {printer.clientOnline && problems.length === 0 && status.detail && (
              <li className={cn('flex items-start gap-3 rounded-2xl px-4 py-3', toneContainer(status.tone))}>{status.detail}</li>
            )}
          </ul>
        )}
        {printer.status.message && printer.clientOnline && (
          <p className="text-sm text-muted-foreground">
            The printer says: <span className="text-foreground">{printer.status.message}</span>
          </p>
        )}
        {printer.status.supplies.length > 0 ? (
          <Supplies supplies={printer.status.supplies} />
        ) : (
          <p className="text-sm text-muted-foreground">This printer doesn't report its ink or toner levels.</p>
        )}
      </div>
    </Section>
  )
}
