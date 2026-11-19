import { PageHeader } from '@/components/page'
import { QueryState } from '@/components/states'
import { Slot } from '@/extensions/slot'
import { useCanManage, useRole, useWorkspace, useWs } from '@/hooks/workspace'
import { ActivitySection } from './activity-section'
import { DangerZone } from './danger-zone'
import { DevicesSection } from './devices-section'
import { EmailSection } from './email-section'
import { ExtensionsSection } from './extensions-section'
import { GeneralSection } from './general-section'
import { JobsSection } from './jobs-section'
import { ReadOnlyNote } from './fields'

export default function WorkspaceSettings() {
  const ws = useWs()
  const workspace = useWorkspace(ws)
  const canManage = useCanManage()
  const isOwner = useRole() === 'owner'
  return (
    <>
      <PageHeader title="Workspace settings" description="How this workspace handles printers, print jobs and email." />
      <QueryState query={workspace}>
        {(data) => (
          <div className="flex flex-col gap-10">
            {!canManage && <ReadOnlyNote>Only owners and admins can change these settings.</ReadOnlyNote>}
            <GeneralSection workspace={data} canManage={canManage} />
            <DevicesSection workspace={data} canManage={canManage} />
            <JobsSection workspace={data} canManage={canManage} />
            <EmailSection workspace={data} canManage={canManage} />
            <ExtensionsSection ws={ws} isOwner={isOwner} />
            <Slot name="settingsSection" props={{ ws, workspace: data }} />
            {canManage && <ActivitySection ws={ws} />}
            {isOwner && <DangerZone workspace={data} />}
          </div>
        )}
      </QueryState>
    </>
  )
}
