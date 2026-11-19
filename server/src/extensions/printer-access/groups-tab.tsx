import { Plus, Users } from 'lucide-react'
import { useState } from 'react'
import type { Group } from '@shared/access'
import { EmptyState, QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useCanManage } from '@/hooks/workspace'
import type { SlotProps } from '../registry'
import { GroupCard } from './group-card'
import { GroupDialog } from './group-dialog'
import { useGroups } from './hooks'

export default function GroupsTab({ ws }: SlotProps['membersTab']) {
  const groups = useGroups(ws)
  const canEdit = useCanManage()
  const [editing, setEditing] = useState<{ group?: Group } | null>(null)
  const newGroup = canEdit && (
    <Button onClick={() => setEditing({})}>
      <Plus data-icon="inline-start" />
      New group
    </Button>
  )

  return (
    <div className="flex flex-col gap-6">
      <QueryState query={groups}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No groups yet"
              description={
                canEdit
                  ? 'Put people and devices in a group, then give the whole group access to printers at once.'
                  : 'Admins can put people and devices in groups to give them printer access together.'
              }
              action={newGroup}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3 px-1">
                <p className="max-w-prose text-sm text-muted-foreground">
                  Groups give several people and devices the same printer access. Someone can be in more than one group.
                </p>
                {newGroup}
              </div>
              {list
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((group) => (
                  <GroupCard key={group.id} ws={ws} group={group} canEdit={canEdit} onEdit={() => setEditing({ group })} />
                ))}
            </>
          )
        }
      </QueryState>
      {editing && (
        <GroupDialog key={editing.group?.id ?? 'new'} ws={ws} group={editing.group} open onOpenChange={(open) => !open && setEditing(null)} />
      )}
    </div>
  )
}
