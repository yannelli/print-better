import { LaptopMinimal, Plus, Printer as PrinterIcon, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Link } from 'wouter'
import type { Printer } from '@shared/types'
import { PageHeader, Section } from '@/components/page'
import { useAppActions, wsHref } from '@/components/shell/app-actions'
import { EmptyState, QueryState } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePrinterRights } from '@/hooks/access'
import { useClients } from '@/hooks/devices'
import { usePrinters, useUpdatePrinter } from '@/hooks/printers'
import { useCanManage, useWs } from '@/hooks/workspace'
import { PrinterCard } from './printer-card'

function FoundRow({ ws, printer, canManage }: { ws: string; printer: Printer; canManage: boolean }) {
  const update = useUpdatePrinter(ws)
  const add = () =>
    update.mutate({ id: printer.id, patch: { added: true } }, { onSuccess: (p) => toast.success(`${p.name} is ready to use`) })
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <PrinterIcon className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{printer.name}</span>
        <span className="truncate text-sm text-muted-foreground">
          {printer.makeModel ? `${printer.makeModel}, found by ${printer.clientName}` : `Found by ${printer.clientName}`}
        </span>
      </div>
      {canManage && (
        <Button variant="outline" onClick={add} disabled={update.isPending} aria-label={`Add ${printer.name}`}>
          {update.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Add
        </Button>
      )}
    </li>
  )
}

function NoPrinters({ ws, hasDevices, canManage }: { ws: string; hasDevices: boolean; canManage: boolean }) {
  if (!hasDevices) {
    return (
      <EmptyState
        icon={LaptopMinimal}
        title="No printers yet"
        description="Printers show up here once a computer or Raspberry Pi near them is connected to Print Better."
        action={
          canManage && (
            <Link href={wsHref(ws, '/devices/add')} className={buttonVariants({ size: 'lg' })}>
              Add your first device
            </Link>
          )
        }
      />
    )
  }
  return (
    <EmptyState
      icon={Search}
      title="Looking for printers"
      description="Your devices haven't found a printer yet. Check that the printer is turned on and on the same network, or plugged in with USB."
      action={
        <Link href={wsHref(ws, '/devices')} className={buttonVariants({ variant: 'outline' })}>
          Go to devices
        </Link>
      }
    />
  )
}

export default function Printers() {
  const ws = useWs()
  const printers = usePrinters(ws)
  const clients = useClients(ws)
  const canManage = useCanManage()
  const rights = usePrinterRights(ws)
  const { openPrint } = useAppActions()
  const sorted = (list: Printer[]) => list.slice().sort((a, b) => a.name.localeCompare(b.name))
  const anyPrintable = printers.data?.some((p) => p.added && rights.can(p.id, 'print')) ?? false

  return (
    <>
      <PageHeader
        title="Printers"
        description="Every printer your devices can reach. Added printers are the ones people can print to."
        actions={anyPrintable && <Button onClick={() => openPrint()}>Print something</Button>}
      />
      <QueryState query={printers}>
        {(list) => {
          const added = sorted(list.filter((p) => p.added))
          // Another device seeing an added printer is the same printer, not a new one to add.
          const addedUuids = new Set(added.flatMap((p) => (p.uuid ? [p.uuid.toLowerCase()] : [])))
          const found = sorted(list.filter((p) => !p.added && !(p.uuid && addedUuids.has(p.uuid.toLowerCase()))))
          if (list.length === 0) return <NoPrinters ws={ws} hasDevices={(clients.data?.length ?? 0) > 0} canManage={canManage} />
          return (
            <div className="flex flex-col gap-10">
              {added.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {added.map((p) => (
                    <PrinterCard key={p.id} ws={ws} printer={p} />
                  ))}
                </div>
              ) : (
                <p className="rounded-3xl border border-dashed px-6 py-8 text-center text-base text-muted-foreground">
                  No printers added yet. {canManage ? 'Add one from the list below.' : 'Ask an admin to add one.'}
                </p>
              )}
              {found.length > 0 && (
                <Section
                  title="Found but not added"
                  description={canManage ? 'Add a printer so people in this workspace can print to it.' : 'An admin can add these so you can print to them.'}
                  flush
                >
                  <ul>
                    {found.map((p) => (
                      <FoundRow key={p.id} ws={ws} printer={p} canManage={rights.can(p.id, 'settings')} />
                    ))}
                  </ul>
                </Section>
              )}
            </div>
          )
        }}
      </QueryState>
    </>
  )
}
