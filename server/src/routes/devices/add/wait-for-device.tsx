import { CheckCircle2, RefreshCw } from 'lucide-react'
import { Link } from 'wouter'
import { toast } from 'sonner'
import { type Client, isMobileOs } from '@shared/types'
import { Mono } from '@/components/page'
import { wsHref } from '@/components/shell/app-actions'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useClientCommand } from '@/hooks/devices'
import { usePrinters } from '@/hooks/printers'
import { plural } from '@/lib/format'
import { deviceKind } from '@/lib/words'
import type { DeviceChoice } from '../detect-os'
import { StepHeading } from './steps'

function Waiting({ kind }: { kind: DeviceChoice }) {
  const isPi = kind === 'pi'
  const isMobile = kind === 'mobile'
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-5 rounded-3xl border bg-card p-6">
        <span aria-hidden className="relative flex size-14 shrink-0 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-container [animation-duration:2.4s]" />
          <span className="relative size-6 rounded-full bg-brand" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">{isMobile ? 'Waiting for your iPhone or iPad…' : 'Waiting for your device…'}</h2>
          <p className="text-muted-foreground">
            {isPi
              ? 'A Raspberry Pi takes about 5 to 10 minutes to start the first time.'
              : isMobile
                ? 'It connects as soon as you scan the code and tap Connect.'
                : 'This usually takes a minute.'}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 text-[0.9375rem]">
        <p className="font-medium">Taking longer than expected? Check that:</p>
        <ul className="ml-5 flex list-disc flex-col gap-1.5 text-muted-foreground">
          {isMobile ? (
            <li>the Print Better app on the iPhone or iPad says it’s connected,</li>
          ) : (
            <li>the install finished without showing an error,</li>
          )}
          <li>the device is turned on and connected to the internet,</li>
          {isPi && <li>the three files were copied to the bootfs drive with their exact names,</li>}
          <li>you used the setup code from this page (it works only once).</li>
        </ul>
      </div>
    </div>
  )
}

function Connected({ ws, client, onContinue }: { ws: string; client: Client; onContinue: () => void }) {
  const printers = (usePrinters(ws).data ?? []).filter((p) => p.clientId === client.id)
  const discover = useClientCommand<{ count: number }>(ws)
  const lookAgain = () =>
    discover.mutate({ id: client.id, name: 'discover' }, { onSuccess: (d) => toast.success(`${plural(d?.count ?? 0, 'printer')} found`) })
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-5 rounded-3xl bg-ok-container p-6 text-on-ok-container">
        <CheckCircle2 className="size-9 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Connected</h2>
          <p>
            <strong>{client.name}</strong> ({deviceKind(client)}
            {client.hostname && client.hostname !== client.name ? <>, <Mono>{client.hostname}</Mono></> : null}) is now part of
            this workspace.
          </p>
        </div>
      </div>
      <StepHeading
        title={printers.length ? `Found ${plural(printers.length, 'printer')}` : 'Looking for printers…'}
        description={
          printers.length
            ? 'Next, choose which ones to use.'
            : 'Make sure your printers are turned on. They can be connected with a cable or on the same network.'
        }
      />
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={onContinue}>
          Continue
        </Button>
        <Button variant="outline" size="lg" onClick={lookAgain} disabled={discover.isPending || !client.online}>
          {discover.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          Look for printers again
        </Button>
      </div>
    </div>
  )
}

function MobileConnected({ ws, client }: { ws: string; client: Client }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-5 rounded-3xl bg-ok-container p-6 text-on-ok-container">
        <CheckCircle2 className="size-9 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Connected</h2>
          <p>
            <strong>{client.name}</strong> can now print to this workspace’s printers, from the Print Better app and from the Share button in
            any app.
          </p>
        </div>
      </div>
      <div>
        <Link href={wsHref(ws, `/devices/${client.id}`)} className={buttonVariants({ size: 'lg' })}>
          Done
        </Link>
      </div>
    </div>
  )
}

export function WaitForDevice({ ws, client, kind, onContinue }: { ws: string; client: Client | null; kind: DeviceChoice; onContinue: () => void }) {
  const connected = client && (isMobileOs(client.os) ? <MobileConnected ws={ws} client={client} /> : <Connected ws={ws} client={client} onContinue={onContinue} />)
  return <div aria-live="polite">{connected || <Waiting kind={kind} />}</div>
}
