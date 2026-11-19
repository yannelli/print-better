import { useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import type { Member, Role } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useUser } from '@/hooks/auth'
import { useMembers, useRemoveMember, useSetRole } from '@/hooks/members'
import { useRole } from '@/hooks/workspace'
import { authApi } from '@/lib/api/auth'
import { initials } from '@/lib/format'
import { qk } from '@/lib/query'
import { ROLE_HELP, ROLE_NAMES } from '@/lib/words'
import { ChoiceSelect } from '../settings/fields'

function RoleControl({ ws, member, myRole }: { ws: string; member: Member; myRole: Role | undefined }) {
  const setRole = useSetRole(ws)
  const canEdit = myRole === 'owner' || (myRole === 'admin' && member.role !== 'owner')
  if (!canEdit) return <span className="text-[0.9375rem] text-muted-foreground">{ROLE_NAMES[member.role]}</span>
  const roles: Role[] = myRole === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin']
  return (
    <ChoiceSelect<Role>
      ariaLabel={`Role for ${member.name}`}
      value={member.role}
      onChange={(role) => role !== member.role && setRole.mutate({ userId: member.userId, role })}
      options={roles.map((r) => ({ value: r, label: ROLE_NAMES[r], description: ROLE_HELP[r] }))}
      disabled={setRole.isPending}
      className="sm:w-44"
    />
  )
}

function LeaveButton({ ws, userId, workspaceName }: { ws: string; userId: string; workspaceName: string }) {
  const remove = useRemoveMember(ws)
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const leave = async () => {
    await remove.mutateAsync(userId)
    await qc.fetchQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 0 })
    navigate('~/', { replace: true })
  }
  return (
    <Confirm
      trigger={<Button variant="outline" size="sm">Leave</Button>}
      title={`Leave ${workspaceName}?`}
      description="You will lose access to its printers. Someone will need to invite you again to come back."
      confirmLabel="Leave workspace"
      destructive
      onConfirm={leave}
    />
  )
}

function RemoveButton({ ws, member }: { ws: string; member: Member }) {
  const remove = useRemoveMember(ws)
  return (
    <Confirm
      trigger={<Button variant="ghost" size="sm">Remove</Button>}
      title={`Remove ${member.name}?`}
      description="They will lose access to this workspace and its printers. Their past print jobs stay in the list."
      confirmLabel="Remove"
      destructive
      onConfirm={() => remove.mutateAsync(member.userId)}
    />
  )
}

export function MemberList({ ws, workspaceName, canManage }: { ws: string; workspaceName: string; canManage: boolean }) {
  const members = useMembers(ws)
  const me = useUser()
  const myRole = useRole()
  return (
    <Section id="people" title="People" flush>
      <QueryState query={members}>
        {(list) => (
          <ul>
            {list.map((member) => {
              const isMe = member.userId === me?.id
              return (
                <li
                  key={member.userId}
                  className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      aria-hidden
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold"
                    >
                      {initials(member.name)}
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[0.9375rem] font-medium">
                        {member.name}
                        {isMe && <span className="font-normal text-muted-foreground"> (you)</span>}
                      </span>
                      <span className="truncate text-sm text-muted-foreground">
                        @{member.username}
                        {member.email && `, ${member.email}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    {canManage ? (
                      <RoleControl ws={ws} member={member} myRole={myRole} />
                    ) : (
                      <span className="text-[0.9375rem] text-muted-foreground">{ROLE_NAMES[member.role]}</span>
                    )}
                    {isMe ? (
                      <LeaveButton ws={ws} userId={member.userId} workspaceName={workspaceName} />
                    ) : (
                      canManage && (myRole === 'owner' || member.role !== 'owner') && <RemoveButton ws={ws} member={member} />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
