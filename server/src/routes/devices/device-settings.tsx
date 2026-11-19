import { useId } from 'react'
import type { Client, ClientSettings } from '@shared/types'
import { OptionCards } from '@/components/option-cards'
import { Row, Section } from '@/components/page'
import { Switch } from '@/components/ui/switch'
import { useUpdateClient } from '@/hooks/devices'
import type { ClientSettingsPatch } from '@/lib/api/devices'

type AutoAdd = ClientSettings['autoAdd']
type Discovery = keyof ClientSettings['discovery']

const DISCOVERY: { key: Discovery; label: string; description: string }[] = [
  { key: 'mdns', label: 'Network printers (Bonjour)', description: 'Most printers made in the last 15 years' },
  { key: 'snmp', label: 'Older network printers (SNMP)', description: 'Office printers that don’t announce themselves' },
  { key: 'usb', label: 'USB printers', description: 'Printers plugged in with a cable' },
  { key: 'os', label: 'Printers already set up on this computer', description: 'Ones you added in the computer’s own settings' },
]

/** Settings shown while a save is in flight, so switches respond instantly. */
export function useShownSettings(client: Client, update: ReturnType<typeof useUpdateClient>): ClientSettings {
  const pending = update.isPending ? update.variables?.patch.settings : undefined
  if (!pending) return client.settings
  return { ...client.settings, ...pending, discovery: { ...client.settings.discovery, ...pending.discovery } }
}

export function DeviceSettings({ ws, client, canManage }: { ws: string; client: Client; canManage: boolean }) {
  const uid = useId()
  const update = useUpdateClient(ws)
  const settings = useShownSettings(client, update)
  const save = (patch: ClientSettingsPatch) => update.mutate({ id: client.id, patch: { settings: patch } })
  const disabled = !canManage

  const toggle = (key: string, label: string, description: string, checked: boolean, onChange: (on: boolean) => void, unavailable = false) => (
    <Row key={key} label={label} description={description} htmlFor={`${uid}-${key}`}>
      <Switch id={`${uid}-${key}`} checked={checked} onCheckedChange={onChange} disabled={disabled || unavailable} />
    </Row>
  )
  const windows = client.os === 'windows'

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Settings"
        description={canManage ? 'Changes are sent to the device right away.' : 'Only admins can change these.'}
        flush
      >
        {toggle('paused', 'Pause printing', 'Hold new print jobs on this device until you turn this off.', settings.paused, (on) =>
          save({ paused: on }),
        )}
        {toggle(
          'lan',
          'Share printers on the local network',
          'Phones and computers nearby can print to these printers without Print Better.',
          settings.lanSharing,
          (on) => save({ lanSharing: on }),
        )}
        {toggle(
          'updates',
          'Install updates automatically',
          windows ? 'Coming soon on Windows.' : 'New versions install in the background, and Print Better restarts on its own.',
          !windows && settings.autoUpdate,
          (on) => save({ autoUpdate: on }),
          windows,
        )}
        {client.os !== 'linux' &&
          toggle(
            'tray',
            client.os === 'macos' ? 'Show icon in the menu bar' : 'Show icon in the system tray',
            'A small Print Better icon that shows whether printing is working.',
            settings.tray,
            (on) => save({ tray: on }),
          )}
        {toggle('debug', 'Detailed activity log', 'Only needed when tracking down a problem.', settings.logLevel === 'debug', (on) =>
          save({ logLevel: on ? 'debug' : 'info' }),
        )}
      </Section>

      <Section title="New printers" description="What to do when this device finds a printer it hasn’t seen before.">
        <OptionCards<AutoAdd>
          label="Add new printers automatically"
          columns={2}
          value={settings.autoAdd}
          onChange={(autoAdd) => save({ autoAdd })}
          options={[
            { value: 'inherit', label: 'Use the workspace setting', description: 'Follow what’s chosen in workspace settings', disabled },
            { value: 'smart', label: 'Add the likely ones', description: 'USB printers, and network printers when there are only a few', disabled },
            { value: 'all', label: 'Add every printer found', description: 'Good for a home with a few printers', disabled },
            { value: 'none', label: 'Ask me first', description: 'New printers wait until you add them', disabled },
          ]}
        />
      </Section>

      <Section title="Where to look for printers" flush>
        {DISCOVERY.map((d) =>
          toggle(d.key, d.label, d.description, settings.discovery[d.key], (on) => save({ discovery: { [d.key]: on } })),
        )}
      </Section>
    </div>
  )
}
