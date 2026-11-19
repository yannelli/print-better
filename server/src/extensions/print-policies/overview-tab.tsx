import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import type { PrintLimitView } from '@shared/policies'
import { allowancePhrase, scopePhrase } from '@shared/policy-text'
import type { Prices } from '@shared/usage'
import { wsHref } from '@/components/shell/app-actions'
import { Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { useCanManage } from '@/hooks/workspace'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { usePrices } from '../usage/hooks'
import { useCycleUsage, useMyUsage, usePolicySources } from './hooks'
import { Meter } from './meter'
import { namesFrom, sentence } from './names'

const SHOWN = 6
const CYCLES = [
  { value: 'current' as const, label: 'This cycle' },
  { value: 'previous' as const, label: 'Last cycle' },
]

function MyLimits({ ws, prices, canManage }: { ws: string; prices: Prices; canManage: boolean }) {
  const mine = useMyUsage(ws)
  return (
    <QueryState query={mine}>
      {({ limits }) =>
        limits.length === 0 ? (
          !canManage && <EmptyState icon={Gauge} title="No limits count your jobs" description="When an admin sets a limit that counts your printing, what is left shows here." />
        ) : (
          <Section id="my-limits" title="Your limits" description="The limits that count your jobs, and what each has left." flush>
            <ul>
              {limits.map((l) => (
                <li key={l.id} className="border-b px-5 py-4 last:border-b-0 sm:px-6">
                  <Meter name={l.name} meter={l} currency={prices.currency} timeZone={prices.timeZone} />
                </li>
              ))}
            </ul>
          </Section>
        )
      }
    </QueryState>
  )
}

function LimitUsage({ limit, prices, names }: { limit: PrintLimitView; prices: Prices; names: ReturnType<typeof namesFrom> }) {
  const [all, setAll] = useState(false)
  const shown = all ? limit.usage : limit.usage.slice(0, SHOWN)
  return (
    <article aria-labelledby={`usage-${limit.id}`} className="overflow-hidden rounded-3xl border bg-card">
      <header className="flex flex-col gap-0.5 border-b px-5 py-4 sm:px-6">
        <h3 id={`usage-${limit.id}`} className="text-lg font-semibold tracking-tight">
          {limit.name}
          {!limit.enabled && <span className="ml-2 text-sm font-normal text-muted-foreground">(off)</span>}
        </h3>
        <p className="text-sm text-muted-foreground">
          {sentence(scopePhrase(limit.scope, names))}: {allowancePhrase(limit, prices.currency)}
        </p>
      </header>
      {limit.usage.length === 0 ? (
        <p className="px-5 py-5 text-muted-foreground sm:px-6">Nobody this limit counts has printed yet.</p>
      ) : (
        <ul>
          {shown.map((u) => (
            <li key={u.subject ? `${u.subject.type}:${u.subject.id}` : 'shared'} className="border-b px-5 py-4 last:border-b-0 sm:px-6">
              <Meter
                name={u.subjectName ?? sentence(u.subject ? names(u.subject.type, u.subject.id) : scopePhrase(limit.scope, names))}
                meter={u}
                currency={prices.currency}
                timeZone={prices.timeZone}
              />
            </li>
          ))}
        </ul>
      )}
      {limit.usage.length > SHOWN && (
        <div className="border-t px-5 py-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${limit.usage.length}`}
          </Button>
        </div>
      )}
    </article>
  )
}

function AllLimits({ ws, prices }: { ws: string; prices: Prices }) {
  const [cycle, setCycle] = useState<'current' | 'previous'>('current')
  const usage = useCycleUsage(ws, cycle)
  const names = namesFrom(usePolicySources(ws))
  return (
    <section aria-labelledby="usage-limits" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="flex flex-col gap-1">
          <h2 id="usage-limits" className="text-lg font-semibold tracking-tight">
            Every limit
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">Who printed how much in each limit, including jobs still waiting or printing.</p>
        </div>
        <ChoiceSelect ariaLabel="Cycle" value={cycle} onChange={setCycle} options={CYCLES} className="sm:w-40" />
      </div>
      <QueryState query={usage}>
        {(limits) =>
          limits.length === 0 ? (
            <EmptyState
              icon={Gauge}
              title="No limits yet"
              description="Limits cap how much each person, group, device or printer prints in a day, week, month, quarter or year."
              action={
                <Link href={wsHref(ws, '/usage/limits')} className={buttonVariants()}>
                  Add a limit
                </Link>
              }
            />
          ) : (
            limits.map((limit) => <LimitUsage key={limit.id} limit={limit} prices={prices} names={names} />)
          )
        }
      </QueryState>
    </section>
  )
}

/** Usage > Overview: your own limits for everyone, every limit's counts for admins. */
export default function OverviewTab({ ws }: SlotProps['usageTab']) {
  const canManage = useCanManage()
  const prices = usePrices(ws)
  return (
    <QueryState query={prices}>
      {(data) => (
        <>
          <MyLimits ws={ws} prices={data} canManage={canManage} />
          {canManage && <AllLimits ws={ws} prices={data} />}
        </>
      )}
    </QueryState>
  )
}
