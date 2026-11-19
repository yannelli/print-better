import { Printer as PrinterIcon } from 'lucide-react'
import { Link, useParams } from 'wouter'
import type { Printer } from '@shared/types'
import { PageHeader } from '@/components/page'
import { useAppActions, wsHref } from '@/components/shell/app-actions'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { StatusPill } from '@/components/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { Slot } from '@/extensions/slot'
import { SlotTabs } from '@/extensions/slot-tabs'
import { usePrinterRights } from '@/hooks/access'
import { usePrinter } from '@/hooks/printers'
import { useWs } from '@/hooks/workspace'
import { ApiError } from '@/lib/api/http'
import { printerStatus } from '@/lib/words'
import { printerPlace } from './printer-card'
import { PrinterActions } from './printer-actions'
import { PrinterDefaults } from './printer-defaults'
import { PrinterInfo } from './printer-info'
import { PrinterSharing } from './printer-sharing'
import { PrinterStatusSection } from './printer-status'

function Overview({ ws, printer, canManage, canPrint }: { ws: string; printer: Printer; canManage: boolean; canPrint: boolean }) {
  return (
    <div className="grid gap-8 xl:grid-cols-2">
      <div className="flex flex-col gap-8">
        <PrinterStatusSection printer={printer} />
        <PrinterDefaults key={printer.id} ws={ws} printer={printer} canManage={canManage} />
      </div>
      <div className="flex flex-col gap-8">
        <PrinterActions ws={ws} printer={printer} canManage={canManage} canPrint={canPrint} />
        <PrinterSharing key={printer.id} ws={ws} printer={printer} canManage={canManage} />
        <PrinterInfo ws={ws} printer={printer} />
      </div>
    </div>
  )
}

export default function PrinterDetail() {
  const ws = useWs()
  const { id } = useParams<{ id: string }>()
  const query = usePrinter(ws, id)
  const rights = usePrinterRights(ws)
  const { openPrint } = useAppActions()
  const back = { href: wsHref(ws, '/printers'), label: 'Printers' }

  const printer = query.data
  if (query.isPending) return <SkeletonRows rows={4} />
  if (!printer && query.error && !(query.error instanceof ApiError && query.error.isNotFound)) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  }
  if (!printer) {
    return (
      <EmptyState
        icon={PrinterIcon}
        title="This printer isn't here anymore"
        description="It may have been forgotten, or its device was removed."
        action={
          <Link href={back.href} className={buttonVariants()}>
            See all printers
          </Link>
        }
      />
    )
  }

  const canManage = rights.can(printer.id, 'settings')
  const canPrint = rights.can(printer.id, 'print')
  return (
    <>
      <PageHeader
        back={back}
        title={printer.name}
        description={printerPlace(printer)}
        actions={
          printer.added && canPrint ? (
            <Button size="lg" onClick={() => openPrint({ printerId: printer.id })}>
              Print
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div aria-live="polite">
            <StatusPill status={printerStatus(printer)} size="lg" />
          </div>
          <Slot name="printerBadge" props={{ ws, printer }} />
        </div>
      </PageHeader>
      {!printer.added && (
        <p className="mb-8 rounded-3xl bg-info-container px-6 py-4 text-on-info-container">
          This printer was found but isn't in use yet. {canManage ? 'Choose “Use this printer” below so people can print to it.' : 'Ask an admin to add it.'}
        </p>
      )}
      <SlotTabs name="printerTab" props={{ ws, printer }} base={`w/${ws}/printers/${printer.id}`} main={{ id: 'overview', label: 'Overview' }}>
        <Overview ws={ws} printer={printer} canManage={canManage} canPrint={canPrint} />
      </SlotTabs>
    </>
  )
}
