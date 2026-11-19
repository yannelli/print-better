import type { AutoAdd, Workspace } from '@shared/types'
import { OptionCards } from '@/components/option-cards'
import { Row, Section } from '@/components/page'
import { Switch } from '@/components/ui/switch'
import { useUpdateWorkspace } from '@/hooks/workspace'
import { useDraft } from './draft'
import { Block, SaveBar } from './fields'

export function DevicesSection({ workspace, canManage }: { workspace: Workspace; canManage: boolean }) {
  const update = useUpdateWorkspace(workspace.id)
  const { draft, dirty, set, reset, changes } = useDraft({
    autoAdd: workspace.settings.autoAdd,
    lanSharing: workspace.settings.lanSharing,
  })

  return (
    <Section
      id="devices"
      title="New devices and printers"
      description="What happens when a device finds printers or joins this workspace."
      flush
    >
      <Block>
        <span className="text-[0.9375rem] font-medium">Add printers automatically</span>
        <OptionCards<AutoAdd>
          label="Add printers automatically"
          value={draft.autoAdd}
          onChange={(autoAdd) => canManage && set({ autoAdd })}
          options={[
            { value: 'smart', label: 'Recommended', description: 'Add USB printers, and network printers on small networks', disabled: !canManage },
            { value: 'all', label: 'All of them', description: 'Add every printer a device finds', disabled: !canManage },
            { value: 'none', label: 'Ask me first', description: 'Nothing is added until you choose it', disabled: !canManage },
          ]}
        />
      </Block>
      <Row
        label="Share printers on the local network"
        htmlFor="ws-lan-sharing"
        description="Starting setting for new devices. Phones and computers nearby can then print to them without Print Better."
      >
        <Switch
          id="ws-lan-sharing"
          checked={draft.lanSharing}
          onCheckedChange={(lanSharing) => set({ lanSharing })}
          disabled={!canManage}
        />
      </Row>
      {canManage && (
        <SaveBar dirty={dirty} pending={update.isPending} onSave={() => update.mutate({ settings: changes() })} onReset={reset} />
      )}
    </Section>
  )
}
