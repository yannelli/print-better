import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { type FormEvent, useId, useMemo, useState } from 'react'
import type { AccessSubject } from '@shared/access'
import type { CostCenter, CostCenterDefaults } from '@shared/enterprise'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useClients } from '@/hooks/devices'
import { useExtensionActive } from '@/hooks/extensions'
import { useMembers } from '@/hooks/members'
import { subjectParam } from '@/lib/api/access'
import { SUBJECT_KINDS } from '@/lib/access-words'
import { qk } from '@/lib/query'
import { ChoiceSelect } from '@/routes/settings/fields'
import { accessApi } from '../printer-access/api'
import { SubjectIcon, SubjectPicker } from '../printer-access/subject-picker'
import { type SubjectKind, type SubjectOption, type SubjectSources, subjectName } from '../printer-access/subjects'
import { enterpriseApi } from './api'
import { useDefaults, useEnterpriseMutation } from './hooks'

type Kind = keyof CostCenterDefaults
type Subject = Exclude<AccessSubject, { type: 'everyone' }>

const KIND_OF: Record<SubjectKind, Kind> = { user: 'members', group: 'groups', client: 'devices' }
const SUBJECT_OF: Record<Kind, SubjectKind> = { members: 'user', groups: 'group', devices: 'client' }
const NONE: never[] = []
const rowClass = 'flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6'

/** Members, devices, and, while Printer access is on, groups. */
function useSources(ws: string): SubjectSources & { kinds: SubjectKind[] } {
  const groupsOn = useExtensionActive(ws, 'printer-access')
  const members = useMembers(ws).data ?? NONE
  const groups = useQuery({ queryKey: qk.groups(ws), queryFn: () => accessApi.groups(ws), enabled: groupsOn }).data ?? NONE
  const clients = useClients(ws).data ?? NONE
  return useMemo(() => ({ members, groups, clients, kinds: groupsOn ? ['user', 'group', 'client'] : ['user', 'client'] }), [members, groups, clients, groupsOn])
}

const centerChoices = (centers: CostCenter[], current?: string) =>
  centers.filter((c) => c.active || c.id === current).map((c) => ({ value: c.id, label: c.active ? c.name : `${c.name} (inactive)` }))

function useSetDefaults(ws: string) {
  return useEnterpriseMutation(ws, (update: Partial<Record<Kind, Record<string, string | null>>>) => enterpriseApi.setDefaults(ws, update), 'Default saved')
}

function DefaultRow({ ws, subject, centerId, centers, sources }: { ws: string; subject: Subject; centerId: string; centers: CostCenter[]; sources: SubjectSources }) {
  const set = useSetDefaults(ws)
  const kind = KIND_OF[subject.type]
  const name = subjectName(subject, sources)
  return (
    <li className={rowClass}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SubjectIcon type={subject.type} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[0.9375rem] font-medium">{name}</span>
          <span className="truncate text-sm text-muted-foreground">{SUBJECT_KINDS[subject.type]}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <ChoiceSelect
          ariaLabel={`Default cost center for ${name}`}
          value={centerId}
          onChange={(next) => next !== centerId && set.mutate({ [kind]: { [subject.id]: next } })}
          options={centerChoices(centers, centerId)}
          disabled={set.isPending}
          className="sm:w-56"
        />
        <Button variant="ghost" size="sm" onClick={() => set.mutate({ [kind]: { [subject.id]: null } })} disabled={set.isPending}>
          Remove
        </Button>
      </div>
    </li>
  )
}

function AddDefault({ ws, centers, sources, taken }: { ws: string; centers: CostCenter[]; sources: ReturnType<typeof useSources>; taken: Set<string> }) {
  const id = useId()
  const set = useSetDefaults(ws)
  const choices = centerChoices(centers)
  const [who, setWho] = useState<SubjectOption | null>(null)
  const [centerId, setCenterId] = useState(choices[0]?.value ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!who || who.subject.type === 'everyone' || !centerId) return
    set.mutate({ [KIND_OF[who.subject.type]]: { [who.subject.id]: centerId } }, { onSuccess: () => setWho(null) })
  }
  if (choices.length === 0) return null
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t bg-surface px-5 py-4 sm:px-6">
      <label htmlFor={`${id}-who`} className="text-[0.9375rem] font-medium">
        Add a default
      </label>
      <div className="flex flex-col gap-2 lg:flex-row">
        <SubjectPicker
          id={`${id}-who`}
          sources={sources}
          kinds={sources.kinds}
          exclude={taken}
          value={who}
          onChange={setWho}
          placeholder={sources.kinds.includes('group') ? undefined : 'Search people or devices'}
          className="lg:flex-1"
        />
        <ChoiceSelect ariaLabel="Cost center" value={centerId} onChange={setCenterId} options={choices} className="lg:w-56" />
        <Button type="submit" disabled={!who || set.isPending}>
          {set.isPending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Add
        </Button>
      </div>
    </form>
  )
}

/** Who is charged to which cost center when they don't pick one. */
export function DefaultsSection({ ws, centers }: { ws: string; centers: CostCenter[] }) {
  const defaults = useDefaults(ws)
  const sources = useSources(ws)
  return (
    <Section
      id="cost-center-defaults"
      title="Defaults"
      description="A job without a cost center is charged to its sender’s default, else their first group’s by name, else the device’s."
      flush
    >
      <QueryState query={defaults}>
        {(data) => {
          const rows = (Object.keys(SUBJECT_OF) as Kind[]).flatMap((kind) =>
            Object.entries(data[kind]).map(([subjectId, centerId]) => ({ subject: { type: SUBJECT_OF[kind], id: subjectId } as Subject, centerId })),
          )
          return (
            <>
              {rows.length === 0 ? (
                <p className="px-5 py-6 text-muted-foreground sm:px-6">No defaults yet.</p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <DefaultRow key={subjectParam(row.subject)} ws={ws} subject={row.subject} centerId={row.centerId} centers={centers} sources={sources} />
                  ))}
                </ul>
              )}
              <AddDefault ws={ws} centers={centers} sources={sources} taken={new Set(rows.map((r) => subjectParam(r.subject)))} />
            </>
          )
        }}
      </QueryState>
    </Section>
  )
}
