import { Check, Minus } from 'lucide-react'
import { useId, useState } from 'react'
import { PRINTER_PERMISSIONS, type WorkspaceAccess } from '@shared/access'
import { Section } from '@/components/page'
import { ErrorState, Loading } from '@/components/states'
import { accessReason, canPhrase, PERMISSION_WORDS } from '@/lib/words'
import { cn } from '@/lib/utils'
import { useExplain, useSubjectSources } from './hooks'
import { reasonNames } from './roles'
import { SubjectPicker } from './subject-picker'
import type { SubjectOption } from './subjects'

const KINDS = ['user', 'group', 'client'] as const

function Result({ ws, printerId, who, access }: { ws: string; printerId: string; who: SubjectOption; access: WorkspaceAccess }) {
  const explain = useExplain(ws, printerId, who.subject)
  const sources = useSubjectSources(ws)
  if (explain.error) return <ErrorState error={explain.error} onRetry={() => explain.refetch()} />
  if (!explain.data) return <Loading label="Checking" className="py-6" />
  const { permissions, sources: why } = explain.data
  const names = reasonNames(access, sources)
  const subject = who.subject.type === 'group' ? `Anyone in ${who.label}` : who.label
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <p className="text-base font-medium">
        {subject} {canPhrase(permissions)}.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {PRINTER_PERMISSIONS.map((p) => {
          const has = permissions.includes(p)
          const Icon = has ? Check : Minus
          return (
            <li key={p} className={cn('flex items-center gap-2 text-[0.9375rem]', !has && 'text-muted-foreground')}>
              <Icon aria-hidden className={cn('size-4 shrink-0', has && 'text-ok')} />
              <span>
                {PERMISSION_WORDS[p].label}
                <span className="sr-only">{has ? ': yes' : ': no'}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {why.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">Why</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.9375rem]">
            {why.map((source, i) => (
              <li key={`${source.kind}-${source.grantId ?? i}`}>{accessReason(source, names)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function CheckAccess({ ws, printerId, access }: { ws: string; printerId: string; access: WorkspaceAccess }) {
  const id = useId()
  const sources = useSubjectSources(ws)
  const [who, setWho] = useState<SubjectOption | null>(null)
  return (
    <Section id="check-access" title="Check someone’s access" description="See what a person, group, or device can do with this printer, and why.">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-who`} className="text-[0.9375rem] font-medium">
            Who
          </label>
          <SubjectPicker id={`${id}-who`} sources={sources} kinds={KINDS} value={who} onChange={setWho} placeholder="Search people, groups, or devices" />
        </div>
        {who && <Result ws={ws} printerId={printerId} who={who} access={access} />}
      </div>
    </Section>
  )
}
