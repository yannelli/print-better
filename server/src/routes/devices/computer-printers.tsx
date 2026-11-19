import { useId, type ReactNode } from 'react'
import type { Client, ClientSettings, Printer, SystemPrinters } from '@shared/types'
import { Mono, Row, Section } from '@/components/page'
import { StatusPill } from '@/components/status'
import { Switch } from '@/components/ui/switch'
import { useUpdateClient } from '@/hooks/devices'
import { useAddedPrinters } from '@/hooks/printers'
import type { ClientSettingsPatch } from '@/lib/api/devices'
import { defaultPrinterProblem, printerSettingsPlace, systemPrinterStatus, thisComputer } from '@/lib/words'
import { ChoiceSelect } from '../settings/fields'
import { useShownSettings } from './device-settings'

const KEEP = 'keep'

function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'bad' }) {
  return tone === 'bad' ? (
    <p role="alert" className="mx-5 my-4 rounded-2xl bg-bad-container px-4 py-3 text-[0.9375rem] text-on-bad-container sm:mx-6">
      {children}
    </p>
  ) : (
    <p className="border-b px-5 py-4 text-muted-foreground last:border-b-0 sm:px-6">{children}</p>
  )
}

interface DefaultProps {
  client: Client
  report: SystemPrinters
  printers: Printer[]
  chosen: Printer | null
}

/** What the default printer row says under its label: today's default, then anything in the way. */
function DefaultDescription({ client, report, printers, chosen }: DefaultProps) {
  const where = thisComputer(client)
  const current = printers.find((p) => p.id === report.defaultPrinterId)
  return (
    <span className="flex flex-col gap-1">
      <span>
        {current ? (
          <>Right now it’s {current.name}.</>
        ) : report.defaultQueue ? (
          <>
            Right now it’s <Mono>{report.defaultQueue}</Mono>, set up on {where}.
          </>
        ) : (
          <>Right now {where} has no default printer.</>
        )}
      </span>
      {chosen && report.defaultProblem && <span>{defaultPrinterProblem(report.defaultProblem, chosen.name, client)}</span>}
      {chosen && client.os === 'macos' && report.lastUsed && (
        <span>
          This Mac opens the print window on the last printer used. To always start on {chosen.name}, open {printerSettingsPlace(client)} and set
          Default printer to {chosen.name}.
        </span>
      )}
      {!client.online && <span>Changes apply when {client.name} is back online.</span>}
    </span>
  )
}

interface ChoicesProps {
  client: Client
  report: SystemPrinters
  settings: ClientSettings
  save: (patch: ClientSettingsPatch) => void
  canManage: boolean
}

function Choices({ client, report, settings, save, canManage }: ChoicesProps) {
  const uid = useId()
  const printers = (useAddedPrinters(client.workspaceId).data ?? []).filter((p) => p.clientId !== client.id)
  const where = thisComputer(client)
  const hidden = new Set(settings.remotePrintersHidden)
  const chosen = printers.find((p) => p.id === settings.defaultPrinter) ?? null

  const setShown = (id: string, shown: boolean) => {
    const next = printers.map((p) => p.id).filter((p) => (p === id ? !shown : hidden.has(p)))
    save({ remotePrintersHidden: next, ...(!shown && settings.defaultPrinter === id && { defaultPrinter: null }) })
  }

  if (printers.length === 0) return <Note>None of your other devices has a printer yet.</Note>
  const options = [
    { value: KEEP, label: 'Don’t change' },
    ...printers.filter((p) => !hidden.has(p.id) || p.id === settings.defaultPrinter).map((p) => ({ value: p.id, label: p.name })),
    ...(settings.defaultPrinter && !chosen ? [{ value: settings.defaultPrinter, label: 'A removed printer' }] : []),
  ]
  return (
    <>
      {report.error && <Note tone="bad">{report.error}</Note>}
      {printers.map((p) => {
        const shown = !hidden.has(p.id)
        const reported = report.printers.find((s) => s.id === p.id)
        const status = systemPrinterStatus(shown ? reported : { installed: null, direct: false, ...reported, state: 'hidden', queue: null }, where)
        return (
          <Row key={p.id} label={p.name} description={`${status.detail}. On ${p.clientName}.`} htmlFor={`${uid}-${p.id}`}>
            <span className="flex items-center gap-3">
              <StatusPill status={status} />
              <Switch id={`${uid}-${p.id}`} checked={shown} onCheckedChange={(on) => setShown(p.id, on)} disabled={!canManage} />
            </span>
          </Row>
        )
      })}
      <Row
        label="Default printer"
        htmlFor={`${uid}-default`}
        description={<DefaultDescription client={client} report={report} printers={printers} chosen={chosen} />}
      >
        <ChoiceSelect
          id={`${uid}-default`}
          value={settings.defaultPrinter ?? KEEP}
          onChange={(value) => save({ defaultPrinter: value === KEEP ? null : value })}
          options={options}
          disabled={!canManage}
        />
      </Row>
    </>
  )
}

/** Remote printers on a desktop: which ones its print window shows, how each is set up there, and its default printer. */
export function ComputerPrinters({ client, canManage }: { client: Client; canManage: boolean }) {
  const uid = useId()
  const update = useUpdateClient(client.workspaceId)
  const settings = useShownSettings(client, update)
  const save = (patch: ClientSettingsPatch) => update.mutate({ id: client.id, patch: { settings: patch } })
  const windows = client.os === 'windows'
  const report = client.systemPrinters

  const body = () => {
    if (windows || !settings.remotePrinters) return null
    if (!report) {
      return client.online ? (
        <Note>Update Print Better on {client.name} to choose its printers from here.</Note>
      ) : (
        <Note>Turn {client.name} on, with the latest Print Better, to choose its printers from here.</Note>
      )
    }
    if (!report.active && report.error) return <Note>{report.error}</Note>
    return <Choices client={client} report={report} settings={settings} save={save} canManage={canManage} />
  }

  return (
    <Section
      title="Printers on this computer"
      description={canManage ? 'Choose which printers from your other devices this computer’s print window shows.' : 'Only admins can change these.'}
      flush
    >
      <Row
        label="Show this workspace’s printers on this computer"
        description={windows ? 'Coming soon on Windows.' : 'Printers connected to your other devices show up in this computer’s print window, so any app can print to them.'}
        htmlFor={`${uid}-remote`}
      >
        <Switch
          id={`${uid}-remote`}
          checked={!windows && settings.remotePrinters}
          onCheckedChange={(on) => save({ remotePrinters: on })}
          disabled={!canManage || windows}
        />
      </Row>
      {body()}
    </Section>
  )
}
