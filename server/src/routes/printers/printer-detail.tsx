import { Printer as PrinterIcon } from 'lucide-react'
import { Link, useParams } from 'wouter'
import { PageHeader } from '@/components/page'
import { useAppActions, wsHref } from '@/components/shell/app-actions'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { StatusPill } from '@/components/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { usePrinter } from '@/hooks/printers'
import { useCanManage, useWs } from '@/hooks/workspace'
import { ApiError } from '@/lib/api/http'
import { printerStatus } from '@/lib/words'
import { printerPlace } from './printer-card'
import { PrinterActions } from './printer-actions'
import { PrinterDefaults } from './printer-defaults'
import { PrinterInfo } from './printer-info'
import { PrinterSharing } from './printer-sharing'
import { PrinterStatusSection } from './printer-status'

export default function PrinterDetail() {
  const ws = useWs()
  const { id } = useParams<{ id: string }>()
  const query = usePrinter(ws, id)
  const canManage = useCanManage()
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

  return (
    <>
      <PageHeader
        back={back}
        title={printer.name}
        description={printerPlace(printer)}
        actions={
          printer.added ? (
            <Button size="lg" onClick={() => openPrint({ printerId: printer.id })}>
              Print
            </Button>
          ) : undefined
        }
      >
        <div aria-live="polite">
          <StatusPill status={printerStatus(printer)} size="lg" />
        </div>
      </PageHeader>
      {!printer.added && (
        <p className="mb-8 rounded-3xl bg-info-container px-6 py-4 text-on-info-container">
          This printer was found but isn't in use yet. {canManage ? 'Choose “Use this printer” below so people can print to it.' : 'Ask an admin to add it.'}
        </p>
      )}
      <div className="grid gap-8 xl:grid-cols-2">
        <div className="flex flex-col gap-8">
          <PrinterStatusSection printer={printer} />
          <PrinterDefaults key={printer.id} ws={ws} printer={printer} canManage={canManage} />
        </div>
        <div className="flex flex-col gap-8">
          <PrinterActions ws={ws} printer={printer} canManage={canManage} />
          <PrinterSharing key={printer.id} ws={ws} printer={printer} canManage={canManage} />
          <PrinterInfo ws={ws} printer={printer} />
        </div>
      </div>
    </>
  )
}
