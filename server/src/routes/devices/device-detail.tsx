import { ChevronRight, LaptopMinimal, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'wouter'
import type { Client, Printer } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Mono, PageHeader, Row, Section } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { EmptyState, QueryState } from '@/components/states'
import { StatusPill } from '@/components/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { Slot } from '@/extensions/slot'
import { useClient, useDownloads, useRemoveClient } from '@/hooks/devices'
import { usePrinters } from '@/hooks/printers'
import { useCanManage, useWs } from '@/hooks/workspace'
import { date, timeAgo } from '@/lib/format'
import { availableUpdate } from '@/lib/updates'
import { deviceKind, OS_NAMES, printerStatus } from '@/lib/words'
import { ComputerPrinters } from './computer-printers'
import { DeviceSettings } from './device-settings'
import { DeviceTools } from './device-tools'
import { deviceStatus, isPhone } from './phone'
import { RenameDevice } from './rename-device'
import { UpdateBadge } from './update-badge'

function About({ client, update }: { client: Client; update: string | null }) {
  return (
    <Section title="About this device" flush>
      {client.hostname && (
        <Row label={isPhone(client) ? 'Device name' : 'Computer name'}>
          <Mono>{client.hostname}</Mono>
        </Row>
      )}
      <Row label="System">
        <span>
          {client.os ? OS_NAMES[client.os] : 'Unknown'}
          {client.arch && (
            <>
              {', '}
              <Mono>{client.arch}</Mono>
            </>
          )}
        </span>
      </Row>
      {client.version && (
        <Row label="Print Better version">
          <Mono>{client.version}</Mono>
          {update && <UpdateBadge version={update} />}
        </Row>
      )}
      {isPhone(client) ? (
        <Row label="Last used">{timeAgo(client.lastSeenAt)}</Row>
      ) : (
        <Row label="Last seen">{client.online ? 'Connected now' : timeAgo(client.lastSeenAt)}</Row>
      )}
      <Row label="Added">{date(client.createdAt)}</Row>
    </Section>
  )
}

function Printers({ ws, printers }: { ws: string; printers: Printer[] }) {
  return (
    <Section title="Printers" description="Printers this device can reach." flush>
      {printers.length === 0 ? (
        <p className="px-5 py-6 text-muted-foreground sm:px-6">No printers found yet. Turn them on, or use “Look for printers” below.</p>
      ) : (
        <ul>
          {printers.map((p) => (
            <li key={p.id} className="border-b last:border-b-0">
              <Link href={wsHref(ws, `/printers/${p.id}`)} className="group flex items-center gap-4 px-5 py-4 hover:bg-muted/60 sm:px-6">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="text-sm text-muted-foreground">{p.added ? (p.location ?? 'In use') : 'Found, not added yet'}</span>
                </span>
                <StatusPill status={printerStatus(p)} />
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Detail({ ws, client }: { ws: string; client: Client }) {
  const canManage = useCanManage()
  const printers = (usePrinters(ws).data ?? []).filter((p) => p.clientId === client.id)
  const remove = useRemoveClient(ws)
  const update = availableUpdate(client, useDownloads().data)
  const [, navigate] = useLocation()
  const [renaming, setRenaming] = useState(false)
  const status = deviceStatus(client)
  const phone = isPhone(client)

  return (
    <>
      <PageHeader
        title={client.name}
        description={deviceKind(client)}
        back={{ href: wsHref(ws, '/devices'), label: 'Devices' }}
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setRenaming(true)}>
                <Pencil data-icon="inline-start" />
                Rename
              </Button>
              <Confirm
                trigger={
                  <Button variant="destructive">
                    <Trash2 data-icon="inline-start" />
                    Remove
                  </Button>
                }
                title={`Remove ${client.name}?`}
                description="It will be signed out of Print Better, and its printers will be removed from this workspace. You can add it again later."
                confirmLabel="Remove device"
                destructive
                onConfirm={async () => {
                  await remove.mutateAsync(client.id)
                  navigate(wsHref(ws, '/devices'))
                }}
              />
            </>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status={status} size="lg" />
          {status.detail && <span className="text-muted-foreground">{status.detail}</span>}
        </div>
      </PageHeader>
      <div className="flex flex-col gap-10">
        {!phone && <Printers ws={ws} printers={printers} />}
        {client.os && !phone && <ComputerPrinters client={client} canManage={canManage} />}
        <Slot name="deviceSection" props={{ ws, client }} />
        {!phone && <DeviceTools ws={ws} client={client} canManage={canManage} update={update} />}
        {!phone && <DeviceSettings ws={ws} client={client} canManage={canManage} />}
        <About client={client} update={update} />
      </div>
      {canManage && <RenameDevice ws={ws} client={client} open={renaming} onOpenChange={setRenaming} />}
    </>
  )
}

export default function DeviceDetail() {
  const ws = useWs()
  const { id } = useParams<{ id: string }>()
  const client = useClient(ws, id)
  return (
    <QueryState query={client}>
      {(found) =>
        found ? (
          <Detail ws={ws} client={found} />
        ) : (
          <EmptyState
            icon={LaptopMinimal}
            title="This device isn’t here"
            description="It may have been removed from this workspace."
            action={
              <Link href={wsHref(ws, '/devices')} className={buttonVariants()}>
                See all devices
              </Link>
            }
          />
        )
      }
    </QueryState>
  )
}
