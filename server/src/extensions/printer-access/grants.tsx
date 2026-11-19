import { Plus } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import type { PrinterGrant, WorkspaceAccess } from '@shared/access'
import { Confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { roleName, SUBJECT_KINDS } from '@/lib/words'
import { ChoiceSelect } from '@/routes/settings/fields'
import { subjectParam } from './api'
import { useGrant, useRevoke, useSubjectSources } from './hooks'
import { roleChoices } from './roles'
import { SubjectIcon, SubjectPicker } from './subject-picker'
import type { SubjectKind, SubjectOption } from './subjects'

type Access = Pick<WorkspaceAccess, 'roles' | 'defaultRole'>

const rowClass = 'flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6'

function Who({ grant, note }: { grant: PrinterGrant; note?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <SubjectIcon type={grant.subject.type} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[0.9375rem] font-medium">{grant.subject.type === 'everyone' ? 'Everyone' : grant.subjectName}</span>
        <span className="truncate text-sm text-muted-foreground">{note ?? SUBJECT_KINDS[grant.subject.type]}</span>
      </div>
    </div>
  )
}

function GrantRow({ ws, grant, access, canEdit }: { ws: string; grant: PrinterGrant; access: Access; canEdit: boolean }) {
  const change = useGrant(ws, grant.printerId)
  const revoke = useRevoke(ws)
  const name = grant.subject.type === 'everyone' ? 'Everyone' : grant.subjectName
  if (!canEdit) {
    return (
      <li className={rowClass}>
        <Who grant={grant} />
        <span className="text-[0.9375rem] text-muted-foreground">{roleName(grant.role, access.roles)}</span>
      </li>
    )
  }
  return (
    <li className={rowClass}>
      <Who grant={grant} />
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <ChoiceSelect
          ariaLabel={`Role for ${name}`}
          value={grant.role}
          onChange={(role) => role !== grant.role && change.mutate({ subject: grant.subject, role })}
          options={roleChoices(access)}
          disabled={change.isPending}
          className="sm:w-48"
        />
        <Confirm
          trigger={<Button variant="ghost" size="sm">Remove</Button>}
          title={`Remove access for ${name}?`}
          description="They keep whatever Everyone and their groups still get."
          confirmLabel="Remove"
          destructive
          onConfirm={() => revoke.mutateAsync(grant.id)}
        />
      </div>
    </li>
  )
}

/** Inherited grants from Workspace settings, shown read-only on a printer. */
export function InheritedRow({ grant, access }: { grant: PrinterGrant; access: Access }) {
  return (
    <li className={rowClass}>
      <Who grant={grant} note={`${SUBJECT_KINDS[grant.subject.type]}, on every printer`} />
      <span className="text-[0.9375rem] text-muted-foreground">{roleName(grant.role, access.roles)}</span>
    </li>
  )
}

function AddGrant({ ws, printerId, access, kinds, taken }: { ws: string; printerId: string | null; access: Access; kinds: SubjectKind[]; taken: Set<string> }) {
  const id = useId()
  const sources = useSubjectSources(ws)
  const grant = useGrant(ws, printerId)
  const [who, setWho] = useState<SubjectOption | null>(null)
  const [role, setRole] = useState('user')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (who) grant.mutate({ subject: who.subject, role }, { onSuccess: () => setWho(null) })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t bg-surface px-5 py-4 sm:px-6">
      <label htmlFor={`${id}-who`} className="text-[0.9375rem] font-medium">
        Give access
      </label>
      <div className="flex flex-col gap-2 lg:flex-row">
        <SubjectPicker id={`${id}-who`} sources={sources} kinds={kinds} exclude={taken} value={who} onChange={setWho} className="lg:flex-1" />
        <ChoiceSelect ariaLabel="Role" value={role} onChange={setRole} options={roleChoices(access)} className="lg:w-48" />
        <Button type="submit" disabled={!who || grant.isPending}>
          {grant.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Add
        </Button>
      </div>
    </form>
  )
}

/** Grants on one printer (`printerId`) or on every printer (`null`), with a form to add more. */
export function GrantList({
  ws,
  printerId,
  grants,
  access,
  canEdit,
  empty,
}: {
  ws: string
  printerId: string | null
  grants: PrinterGrant[]
  access: Access
  canEdit: boolean
  empty: string
}) {
  const kinds: SubjectKind[] = printerId ? ['user', 'group', 'client'] : ['everyone', 'user', 'group', 'client']
  const taken = new Set(grants.map((g) => subjectParam(g.subject)))
  return (
    <>
      {grants.length === 0 ? (
        <p className="px-5 py-6 text-muted-foreground sm:px-6">{empty}</p>
      ) : (
        <ul>
          {grants.map((g) => (
            <GrantRow key={g.id} ws={ws} grant={g} access={access} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {canEdit && <AddGrant ws={ws} printerId={printerId} access={access} kinds={kinds} taken={taken} />}
    </>
  )
}
