import { CheckCircle2, CircleArrowUp, Download, RefreshCw, RotateCcw, ScrollText, Stethoscope, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import type { UpdateResult } from '@shared/protocol'
import type { Client } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { CopyButton } from '@/components/copy'
import { Row, Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useClientCommand } from '@/hooks/devices'
import type { DiagnoseCheck } from '@/lib/api/types'
import { plural } from '@/lib/format'
import { downloadText } from './cloud-init'

function ToolButton({
  pending,
  icon,
  children,
  disabled,
  onClick,
}: {
  pending: boolean
  icon: ReactNode
  children: ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button variant="outline" disabled={disabled || pending} onClick={onClick}>
      {pending ? <Spinner data-icon="inline-start" /> : icon}
      {children}
    </Button>
  )
}

function Checkup({ checks }: { checks: DiagnoseCheck[] }) {
  const failed = checks.filter((c) => !c.ok).length
  return (
    <div className="flex flex-col gap-3 border-b px-5 pb-5 sm:px-6">
      <p className="font-medium">{failed ? `${plural(failed, 'problem')} found` : 'Everything looks good'}</p>
      <ul className="flex flex-col gap-2">
        {checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-start gap-3 rounded-2xl bg-surface p-3">
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-label="Passed" />
            ) : (
              <XCircle className="mt-0.5 size-5 shrink-0 text-bad" aria-label="Problem" />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{c.name.charAt(0).toUpperCase() + c.name.slice(1)}</span>
              {c.detail && <span className="text-sm break-words text-muted-foreground">{c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LogViewer({ name, lines }: { name: string; lines: string[] }) {
  const text = lines.join('\n')
  return (
    <div className="flex flex-col gap-3 border-b px-5 pb-5 sm:px-6">
      <div className="flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy log" />
        <Button variant="outline" size="sm" onClick={() => downloadText(`${name}-log.txt`, text)}>
          <Download data-icon="inline-start" />
          Download
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label="Activity log"
        className="max-h-96 overflow-auto rounded-2xl border bg-surface p-4 font-mono text-[0.8125rem] leading-relaxed whitespace-pre"
      >
        {text || 'The log is empty.'}
      </pre>
    </div>
  )
}

export function DeviceTools({ ws, client, canManage, update }: { ws: string; client: Client; canManage: boolean; update: string | null }) {
  const discover = useClientCommand<{ count: number }>(ws)
  const diagnose = useClientCommand<{ checks: DiagnoseCheck[] }>(ws)
  const logs = useClientCommand<{ lines: string[] }>(ws)
  const restart = useClientCommand(ws)
  const upgrade = useClientCommand<UpdateResult>(ws)
  const unavailable = !client.online || !canManage
  const reason = !canManage ? 'Only admins can use these.' : !client.online ? `Turn on ${client.name} to use these.` : undefined
  const fileName = (client.hostname ?? client.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-')

  return (
    <Section title="Tools" description={reason} flush>
      {update && (
        <Row label={`Update to ${update}`} description="Installs the new version and restarts Print Better. Printing pauses for a few seconds.">
          <ToolButton
            pending={upgrade.isPending}
            disabled={unavailable}
            icon={<CircleArrowUp data-icon="inline-start" />}
            onClick={() =>
              upgrade.mutate(
                { id: client.id, name: 'update' },
                { onSuccess: (r) => toast.success(`Updating ${client.name} to ${r.to}. It restarts when the update is installed.`) },
              )
            }
          >
            Update now
          </ToolButton>
        </Row>
      )}
      <Row
        label="Look for printers"
        description={
          <span aria-live="polite">
            {discover.isSuccess ? `${plural(discover.data?.count ?? 0, 'printer')} found` : 'Check again for printers nearby or plugged in.'}
          </span>
        }
      >
        <ToolButton pending={discover.isPending} disabled={unavailable} icon={<RefreshCw data-icon="inline-start" />} onClick={() => discover.mutate({ id: client.id, name: 'discover' })}>
          Look now
        </ToolButton>
      </Row>
      <Row label="Run a checkup" description="Tests the connection, the clock, and each printer.">
        <ToolButton pending={diagnose.isPending} disabled={unavailable} icon={<Stethoscope data-icon="inline-start" />} onClick={() => diagnose.mutate({ id: client.id, name: 'diagnose' })}>
          Run checkup
        </ToolButton>
      </Row>
      <div aria-live="polite">{diagnose.data && <Checkup checks={diagnose.data.checks ?? []} />}</div>
      <Row label="Show recent activity log" description="The last 500 lines. Useful when asking for help.">
        <ToolButton pending={logs.isPending} disabled={unavailable} icon={<ScrollText data-icon="inline-start" />} onClick={() => logs.mutate({ id: client.id, name: 'logs', args: { lines: 500 } })}>
          {logs.data ? 'Refresh log' : 'Show log'}
        </ToolButton>
      </Row>
      {logs.data && <LogViewer name={fileName} lines={logs.data.lines ?? []} />}
      <Row label="Restart the app" description="Restarts Print Better on this device. Printing pauses for a few seconds.">
        <Confirm
          trigger={
            <Button variant="outline" disabled={unavailable}>
              <RotateCcw data-icon="inline-start" />
              Restart
            </Button>
          }
          title={`Restart Print Better on ${client.name}?`}
          description="Jobs waiting to print are kept and continue after the restart."
          confirmLabel="Restart"
          onConfirm={() =>
            restart.mutateAsync(
              { id: client.id, name: 'restart' },
              { onSuccess: () => toast.success(`Restarting ${client.name}. It’ll be back in a few seconds.`) },
            )
          }
        />
      </Row>
    </Section>
  )
}
