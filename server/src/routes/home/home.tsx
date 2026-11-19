import { LaptopMinimal, Printer as PrinterIcon } from 'lucide-react'
import { Link } from 'wouter'
import { PageHeader } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { useUser } from '@/hooks/auth'
import { useClients } from '@/hooks/devices'
import { useAddedPrinters } from '@/hooks/printers'
import { useCanManage, useWs } from '@/hooks/workspace'
import { PrinterCard } from '../printers/printer-card'
import { PaperDrop } from './paper-drop'
import { RecentJobs } from './recent-jobs'

function greeting(name: string | undefined) {
  const hour = new Date().getHours()
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

function Setup({ ws, hasDevices }: { ws: string; hasDevices: boolean }) {
  const canManage = useCanManage()
  if (!hasDevices) {
    return (
      <EmptyState
        icon={LaptopMinimal}
        title="Connect your first printer"
        description="Install Print Better on a computer or Raspberry Pi that can reach your printer. It finds the printer for you."
        action={
          canManage ? (
            <Link href={wsHref(ws, '/devices/add')} className={buttonVariants({ size: 'lg' })}>
              Add your first device
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">Ask an admin of this workspace to add a device.</p>
          )
        }
      />
    )
  }
  return (
    <EmptyState
      icon={PrinterIcon}
      title="Choose which printers to use"
      description="Your devices are connected. Pick the printers you want to print to, or wait a moment while they are found."
      action={
        <Link href={wsHref(ws, '/printers')} className={buttonVariants({ size: 'lg' })}>
          See printers
        </Link>
      }
    />
  )
}

export default function Home() {
  const ws = useWs()
  const user = useUser()
  const printers = useAddedPrinters(ws)
  const clients = useClients(ws)
  const list = printers.data ?? []
  const loading = printers.isPending || clients.isPending

  return (
    <>
      <PageHeader title={greeting(user?.name)} description={list.length > 0 ? 'What would you like to print today?' : undefined} />
      {printers.error ? (
        <ErrorState error={printers.error} onRetry={() => printers.refetch()} />
      ) : loading ? (
        <SkeletonRows rows={3} />
      ) : list.length === 0 ? (
        <Setup ws={ws} hasDevices={(clients.data?.length ?? 0) > 0} />
      ) : (
        <div className="flex flex-col gap-12">
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-10">
            <PaperDrop />
            <section aria-labelledby="home-printers" className="flex flex-col gap-3">
              <h2 id="home-printers" className="px-1 text-lg font-semibold tracking-tight">
                Your printers
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {list.map((p) => (
                  <PrinterCard key={p.id} ws={ws} printer={p} />
                ))}
              </div>
            </section>
          </div>
          <RecentJobs ws={ws} />
        </div>
      )}
    </>
  )
}
