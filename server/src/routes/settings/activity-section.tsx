import type { AuditEntry } from '@shared/types'
import { History } from 'lucide-react'
import { Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { useAudit } from '@/hooks/members'
import { dateTime, timeAgo } from '@/lib/format'

const NOUNS: Record<string, string> = {
  client: 'Device',
  device: 'Device',
  printer: 'Printer',
  job: 'Print job',
  member: 'Member',
  invite: 'Invite',
  workspace: 'Workspace',
  enrollment: 'Device install code',
  token: 'API token',
  settings: 'Settings',
  passkey: 'Passkey',
  password: 'Password',
  recovery: 'Recovery codes',
  identity: 'Sign-in account',
  user: 'Account',
  reset: 'Password reset link',
  app: 'Connected app',
  access: 'Printer access',
  group: 'Group',
  extension: 'Extension',
}

const VERBS: Record<string, string> = {
  create: 'created',
  update: 'changed',
  delete: 'deleted',
  remove: 'removed',
  add: 'added',
  approve: 'approved',
  deny: 'turned down',
  cancel: 'canceled',
  retry: 'retried',
  accept: 'accepted',
  enroll: 'paired',
  pair: 'paired',
  unpair: 'unpaired',
  command: 'sent a command',
  leave: 'left',
  upload: 'uploaded',
  link: 'linked',
  reset: 'reset',
  grant: 'given',
  revoke: 'removed',
  'role create': 'role created',
  'role update': 'role changed',
  'role delete': 'role deleted',
}

const ACTORS: Record<AuditEntry['actorType'], string> = {
  user: 'Someone',
  token: 'An API token',
  client: 'A device',
  email: 'Email',
  system: 'Print Better',
}

function describe(action: string) {
  const [noun, ...rest] = action.split(/[._]/)
  const verb = rest.join(' ')
  const subject = NOUNS[noun] ?? noun.charAt(0).toUpperCase() + noun.slice(1)
  return verb ? `${subject} ${VERBS[verb] ?? verb.replace(/-/g, ' ')}` : subject
}

export function ActivitySection({ ws }: { ws: string }) {
  const audit = useAudit(ws)
  return (
    <Section id="activity" title="Recent activity" description="Changes made in this workspace, newest first." flush>
      <QueryState query={audit}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState icon={History} title="Nothing yet" description="Changes to printers, devices and people will show up here." className="border-0" />
          ) : (
            <ul>
              {page.items.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-0.5 border-b px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 sm:px-6">
                  <span className="text-[0.9375rem]">
                    <span className="font-medium">{entry.actorName ?? ACTORS[entry.actorType]}</span>
                    <span className="text-muted-foreground">: </span>
                    {describe(entry.action)}
                    {entry.target && <span className="text-muted-foreground"> ({entry.target})</span>}
                  </span>
                  <time dateTime={new Date(entry.createdAt).toISOString()} title={dateTime(entry.createdAt)} className="shrink-0 text-sm text-muted-foreground">
                    {timeAgo(entry.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </Section>
  )
}
