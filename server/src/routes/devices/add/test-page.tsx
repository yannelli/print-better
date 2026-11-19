import { CheckCircle2, Printer as PrinterIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import type { Client } from '@shared/types'
import { OptionCards } from '@/components/option-cards'
import { wsHref } from '@/components/shell/app-actions'
import { StatusPill } from '@/components/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePrinterAction, usePrinters } from '@/hooks/printers'
import { printerStatus } from '@/lib/words'
import { StepHeading } from './steps'

export function TestPage({ ws, client }: { ws: string; client: Client }) {
  const printers = (usePrinters(ws).data ?? []).filter((p) => p.clientId === client.id && p.added)
  const [choice, setChoice] = useState('')
  const printerId = choice || printers[0]?.id || ''
  const printer = printers.find((p) => p.id === printerId)
  const testPage = usePrinterAction(ws, 'testPage')

  if (printers.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeading
          title="No printers added yet"
          description={`When ${client.name} finds a printer, add it from the Printers page and print a test page from there.`}
        />
        <div className="flex flex-wrap gap-3">
          <Link href={wsHref(ws)} className={buttonVariants({ size: 'lg' })}>
            Go to Home
          </Link>
          <Link href={wsHref(ws, '/printers')} className={buttonVariants({ size: 'lg', variant: 'outline' })}>
            Open Printers
          </Link>
        </div>
      </div>
    )
  }

  if (testPage.isSuccess && printer) {
    return (
      <div className="flex flex-col gap-6" aria-live="polite">
        <div className="flex items-start gap-5 rounded-3xl bg-ok-container p-6 text-on-ok-container">
          <CheckCircle2 className="size-9 shrink-0" aria-hidden />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold tracking-tight">You’re all set</h2>
            <p>A test page is on its way to {printer.name}. If it doesn’t come out, the printer’s page shows what’s wrong.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href={wsHref(ws)} className={buttonVariants({ size: 'lg' })}>
            Go to Home
          </Link>
          <Link href={wsHref(ws, `/printers/${printer.id}`)} className={buttonVariants({ size: 'lg', variant: 'outline' })}>
            Open {printer.name}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        title="Print a test page"
        description="One page to check everything works, from this website all the way to paper."
      />
      {printers.length > 1 && (
        <OptionCards
          label="Printer for the test page"
          columns={2}
          layout="inline"
          value={printerId}
          onChange={setChoice}
          options={printers.map((p) => ({
            value: p.id,
            label: p.name,
            description: <StatusPill status={printerStatus(p)} className="mt-1" />,
            media: <PrinterIcon />,
          }))}
        />
      )}
      {printers.length === 1 && printer && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border bg-card p-4">
          <span className="font-medium">{printer.name}</span>
          <StatusPill status={printerStatus(printer)} />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Button size="lg" disabled={!printer || testPage.isPending} onClick={() => testPage.mutate(printerId)}>
          {testPage.isPending ? <Spinner data-icon="inline-start" /> : <PrinterIcon data-icon="inline-start" />}
          Print a test page
        </Button>
        <Link href={wsHref(ws)} className={buttonVariants({ size: 'lg', variant: 'ghost' })}>
          Skip and finish
        </Link>
      </div>
    </div>
  )
}
