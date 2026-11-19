import { PageHeader } from '@/components/page'
import { useCanManage, useWorkspaceSummary, useWs } from '@/hooks/workspace'
import { InviteDialog } from './invite-dialog'
import { InviteList } from './invite-list'
import { MemberList } from './member-list'

export default function Members() {
  const ws = useWs()
  const canManage = useCanManage()
  const workspaceName = useWorkspaceSummary()?.name ?? 'this workspace'
  return (
    <>
      <PageHeader
        title="Members"
        description={`People who can print and see printers in ${workspaceName}.`}
        actions={canManage && <InviteDialog ws={ws} />}
      />
      <div className="flex flex-col gap-10">
        <MemberList ws={ws} workspaceName={workspaceName} canManage={canManage} />
        {canManage && <InviteList ws={ws} />}
      </div>
    </>
  )
}
