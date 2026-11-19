import { Pencil, Plus, Trash2 } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import type { Group, GroupMember } from '@shared/access'
import { Confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { subjectParam } from '@/lib/api/access'
import { groupSize, SUBJECT_KINDS } from '@/lib/words'
import { useDeleteGroup, useSetGroupMember, useSubjectSources } from './hooks'
import { SubjectIcon, SubjectPicker } from './subject-picker'
import type { SubjectOption } from './subjects'

const KINDS = ['user', 'client'] as const

function MemberRow({ ws, group, member, canEdit }: { ws: string; group: Group; member: GroupMember; canEdit: boolean }) {
  const set = useSetGroupMember(ws)
  return (
    <li className="flex items-center gap-3 border-b px-5 py-3 last:border-b-0 sm:px-6">
      <SubjectIcon type={member.type} className="size-9" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.9375rem] font-medium">{member.name}</span>
        <span className="text-sm text-muted-foreground">{SUBJECT_KINDS[member.type]}</span>
      </div>
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          disabled={set.isPending}
          onClick={() => set.mutate({ groupId: group.id, member, inGroup: false })}
          aria-label={`Remove ${member.name} from ${group.name}`}
        >
          {set.isPending && <Spinner data-icon="inline-start" />}
          Remove
        </Button>
      )}
    </li>
  )
}

function AddMember({ ws, group }: { ws: string; group: Group }) {
  const id = useId()
  const sources = useSubjectSources(ws)
  const set = useSetGroupMember(ws)
  const [who, setWho] = useState<SubjectOption | null>(null)
  const inGroup = new Set(group.members.map((m) => subjectParam(m)))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (who?.subject.type !== 'user' && who?.subject.type !== 'client') return
    set.mutate({ groupId: group.id, member: who.subject, inGroup: true }, { onSuccess: () => setWho(null) })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t bg-surface px-5 py-4 sm:flex-row sm:px-6">
      <label htmlFor={`${id}-who`} className="sr-only">
        Add a person or device to {group.name}
      </label>
      <SubjectPicker
        id={`${id}-who`}
        sources={sources}
        kinds={KINDS}
        exclude={inGroup}
        value={who}
        onChange={setWho}
        placeholder="Add a person or device"
        className="sm:flex-1"
      />
      <Button type="submit" variant="outline" disabled={!who || set.isPending}>
        {set.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
        Add
      </Button>
    </form>
  )
}

export function GroupCard({ ws, group, canEdit, onEdit }: { ws: string; group: Group; canEdit: boolean; onEdit: () => void }) {
  const remove = useDeleteGroup(ws)
  return (
    <article aria-labelledby={`group-${group.id}`} className="overflow-hidden rounded-3xl border bg-card">
      <header className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={`group-${group.id}`} className="text-lg font-semibold tracking-tight">
            {group.name}
          </h3>
          {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
          <p className="text-sm text-muted-foreground">{groupSize(group.members)}</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
            <Confirm
              trigger={
                <Button variant="ghost" size="sm">
                  <Trash2 data-icon="inline-start" />
                  Delete
                </Button>
              }
              title={`Delete ${group.name}?`}
              description="Any printer access given to this group is removed too. Its people and devices keep the access they get in other ways."
              confirmLabel="Delete group"
              destructive
              onConfirm={() => remove.mutateAsync(group.id)}
            />
          </div>
        )}
      </header>
      {group.members.length === 0 ? (
        <p className="px-5 py-5 text-muted-foreground sm:px-6">Nobody is in this group yet.</p>
      ) : (
        <ul>
          {group.members.map((m) => (
            <MemberRow key={`${m.type}:${m.id}`} ws={ws} group={group} member={m} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {canEdit && <AddMember ws={ws} group={group} />}
    </article>
  )
}
