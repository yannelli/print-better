import { ChevronRight, LaptopMinimal, Plus } from 'lucide-react'
import { Link } from 'wouter'
import type { Client, Printer } from '@shared/types'
import { Mono, PageHeader } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { EmptyState, QueryState } from '@/components/states'
import { StatusPill } from '@/components/status'
import { buttonVariants } from '@/components/ui/button'
import { useClients, useDownloads } from '@/hooks/devices'
import { usePrinters } from '@/hooks/printers'
import { useCanManage, useWs } from '@/hooks/workspace'
import { plural, timeAgo } from '@/lib/format'
import { availableUpdate } from '@/lib/updates'
import { clientStatus, deviceKind } from '@/lib/words'
import { DeviceIcon } from './device-icon'
import { UpdateBadge } from './update-badge'

function DeviceRow({ ws, client, printers, update }: { ws: string; client: Client; printers: Printer[]; update: string | null }) {
  const added = printers.filter((p) => p.added).length
  const found = printers.length - added
  return (
    <li className="border-b last:border-b-0">
      <Link
        href={wsHref(ws, `/devices/${client.id}`)}
        className="group flex items-center gap-4 px-5 py-4 hover:bg-muted/60 sm:px-6"
      >
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <DeviceIcon client={client} className="size-6" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-base font-medium">{client.name}</span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{deviceKind(client)}</span>
            <span>
              {plural(added, 'printer')}
              {found > 0 && `, ${found} more found`}
            </span>
            {!client.online && <span>Last seen {timeAgo(client.lastSeenAt)}</span>}
            {client.version && <Mono>v{client.version}</Mono>}
            {update && <UpdateBadge version={update} />}
          </span>
        </span>
        <StatusPill status={clientStatus(client)} />
        <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  )
}

export default function Devices() {
  const ws = useWs()
  const canManage = useCanManage()
  const clients = useClients(ws)
  const printers = usePrinters(ws).data ?? []
  const manifest = useDownloads().data
  const addButton = canManage && (
    <Link href={wsHref(ws, '/devices/add')} className={buttonVariants()}>
      <Plus data-icon="inline-start" />
      Add a device
    </Link>
  )
  return (
    <>
      <PageHeader
        title="Devices"
        description="Computers and Raspberry Pis that connect your printers to Print Better."
        actions={clients.data?.length ? addButton : undefined}
      />
      <QueryState query={clients}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={LaptopMinimal}
              title="No devices yet"
              description="Add a computer or Raspberry Pi that’s near your printers. It connects them to Print Better so you can print from anywhere."
              action={
                canManage ? (
                  <Link href={wsHref(ws, '/devices/add')} className={buttonVariants({ size: 'lg' })}>
                    <Plus data-icon="inline-start" />
                    Add your first device
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">Ask an admin of this workspace to add one.</p>
                )
              }
            />
          ) : (
            <ul className="overflow-hidden rounded-3xl border bg-card" aria-label="Devices">
              {[...list]
                .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
                .map((client) => (
                  <DeviceRow
                    key={client.id}
                    ws={ws}
                    client={client}
                    printers={printers.filter((p) => p.clientId === client.id)}
                    update={availableUpdate(client, manifest)}
                  />
                ))}
            </ul>
          )
        }
      </QueryState>
    </>
  )
}
