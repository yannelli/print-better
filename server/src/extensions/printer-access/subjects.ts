import type { AccessSubject, Group } from '@shared/access'
import type { Client, Member } from '@shared/types'
import { subjectParam } from '@/lib/api/access'
import { groupSize } from '@/lib/words'

/** Kinds a picker offers. Everyone is set through Everyone settings, never picked. */
export type SubjectKind = Exclude<AccessSubject['type'], 'everyone'>

export interface SubjectOption {
  key: string
  subject: AccessSubject
  label: string
  detail?: string
}

export interface SubjectGroup {
  value: string
  items: SubjectOption[]
}

export interface SubjectSources {
  members: readonly Member[]
  groups: readonly Group[]
  clients: readonly Client[]
}

const option = (subject: AccessSubject, label: string, detail?: string): SubjectOption => ({ key: subjectParam(subject), subject, label, detail })
const byLabel = (a: SubjectOption, b: SubjectOption) => a.label.localeCompare(b.label)

/** Picker sections for the kinds asked for, leaving out subjects in `exclude` (keys from `subjectParam`). */
export function subjectGroups(sources: SubjectSources, kinds: readonly SubjectKind[], exclude: ReadonlySet<string> = new Set()): SubjectGroup[] {
  const sections: [SubjectKind, string, SubjectOption[]][] = [
    ['user', 'People', sources.members.map((m) => option({ type: 'user', id: m.userId }, m.name, `@${m.username}`)).sort(byLabel)],
    ['group', 'Groups', sources.groups.map((g) => option({ type: 'group', id: g.id }, g.name, groupSize(g.members))).sort(byLabel)],
    ['client', 'Devices', sources.clients.map((c) => option({ type: 'client', id: c.id }, c.name)).sort(byLabel)],
  ]
  return sections
    .filter(([kind]) => kinds.includes(kind))
    .map(([, value, items]) => ({ value, items: items.filter((o) => !exclude.has(o.key)) }))
    .filter((section) => section.items.length > 0)
}

/** A subject's name from the loaded lists, for sentences; never an id. */
export function subjectName(subject: AccessSubject, sources: SubjectSources): string {
  switch (subject.type) {
    case 'everyone':
      return 'Everyone'
    case 'user':
      return sources.members.find((m) => m.userId === subject.id)?.name ?? 'A former member'
    case 'group':
      return sources.groups.find((g) => g.id === subject.id)?.name ?? 'A deleted group'
    case 'client':
      return sources.clients.find((c) => c.id === subject.id)?.name ?? 'A removed device'
  }
}
