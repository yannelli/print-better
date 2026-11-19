import type { Workspace } from '@shared/types'
import { PageHeader } from '@/components/page'
import { QueryState } from '@/components/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SlotItem, useSlot } from '@/extensions/slot'
import { useCanManage, useRole, useWorkspace, useWs } from '@/hooks/workspace'
import { ActivitySection } from './activity-section'
import { DangerZone } from './danger-zone'
import { DevicesSection } from './devices-section'
import { EmailSection } from './email-section'
import { ExtensionsSection } from './extensions-section'
import { ReadOnlyNote } from './fields'
import { GeneralSection } from './general-section'
import { JobsSection } from './jobs-section'
import { useTab } from './use-tab'

function SettingsTabs({ ws, workspace }: { ws: string; workspace: Workspace }) {
  const canManage = useCanManage()
  const isOwner = useRole() === 'owner'
  const props = { ws, workspace }
  const extra = useSlot('settingsTab', props)
  // Extension tabs sit before Extensions, so turning one on adds its tab next to the switch.
  const tabs = ['general', 'printing', 'email', ...extra.map((t) => t.id), 'extensions', ...(canManage ? ['activity'] : [])]
  const [tab, setTab] = useTab(`w/${ws}/settings`, tabs)
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as string)} className="gap-8">
      <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="printing">Printing</TabsTrigger>
        <TabsTrigger value="email">Email to print</TabsTrigger>
        {extra.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
        <TabsTrigger value="extensions">Extensions</TabsTrigger>
        {canManage && <TabsTrigger value="activity">Activity</TabsTrigger>}
      </TabsList>
      <TabsContent value="general" className="flex flex-col gap-10">
        <GeneralSection workspace={workspace} canManage={canManage} />
        {isOwner && <DangerZone workspace={workspace} />}
      </TabsContent>
      <TabsContent value="printing" className="flex flex-col gap-10">
        <JobsSection workspace={workspace} canManage={canManage} />
        <DevicesSection workspace={workspace} canManage={canManage} />
      </TabsContent>
      <TabsContent value="email" className="flex flex-col gap-10">
        <EmailSection workspace={workspace} canManage={canManage} />
      </TabsContent>
      {extra.map((t) => (
        <TabsContent key={t.id} value={t.id} className="flex flex-col gap-10">
          <SlotItem entry={t} props={props} />
        </TabsContent>
      ))}
      <TabsContent value="extensions" className="flex flex-col gap-10">
        <ExtensionsSection ws={ws} isOwner={isOwner} />
      </TabsContent>
      {canManage && (
        <TabsContent value="activity" className="flex flex-col gap-10">
          <ActivitySection ws={ws} />
        </TabsContent>
      )}
    </Tabs>
  )
}

export default function WorkspaceSettings() {
  const ws = useWs()
  const workspace = useWorkspace(ws)
  const canManage = useCanManage()
  return (
    <>
      <PageHeader title="Workspace settings" description="How this workspace handles printers, print jobs and email." />
      <QueryState query={workspace}>
        {(data) => (
          <div className="flex flex-col gap-8">
            {!canManage && <ReadOnlyNote>Only owners and admins can change these settings.</ReadOnlyNote>}
            <SettingsTabs ws={ws} workspace={data} />
          </div>
        )}
      </QueryState>
    </>
  )
}
