import { Gauge, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PrintLimitView } from '@shared/policies'
import { allowancePhrase, scopePhrase } from '@shared/policy-text'
import type { Prices } from '@shared/usage'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { SlotProps } from '../registry'
import { usePrices } from '../usage/hooks'
import { meterLine } from '../usage/words'
import { AllowanceDialog } from './allowance-dialog'
import { useDeleteLimit, useLimits, usePolicySources } from './hooks'
import { LimitDialog } from './limit-dialog'
import { namesFrom, sentence } from './names'

const PER_SUBJECT: Partial<Record<PrintLimitView['scope']['type'], string>> = { 'each-member': 'members', 'each-device': 'devices', 'group-each': 'members and devices' }

/** How full the limit is this cycle, in one line. */
function usageSummary(limit: PrintLimitView, prices: Prices): string {
  const who = PER_SUBJECT[limit.scope.type]
  if (limit.usage.length === 0) return 'Nothing to count yet'
  if (!who) return sentence(meterLine(limit.usage[0], prices.currency, prices.timeZone))
  const full = limit.usage.filter((u) => u.left <= 0).length
  return full === 0 ? `${limit.usage.length} ${who}, none at the limit yet` : `${full} of ${limit.usage.length} ${who} at the limit`
}

function LimitRow({ ws, limit, prices, names, onEdit, onExtra }: {
  ws: string
  limit: PrintLimitView
  prices: Prices
  names: ReturnType<typeof namesFrom>
  onEdit: () => void
  onExtra: () => void
}) {
  const remove = useDeleteLimit(ws)
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium">
          {limit.name}
          {!limit.enabled && <Badge variant="outline">Off</Badge>}
        </span>
        <span className="text-sm text-muted-foreground">
          {sentence(scopePhrase(limit.scope, names))}: {allowancePhrase(limit, prices.currency)}
          {limit.exemptAdmins && ". Doesn't apply to owners and admins"}
        </span>
        <span className="text-sm text-muted-foreground">{usageSummary(limit, prices)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
        <Button variant="outline" size="sm" onClick={onExtra}>
          <Plus data-icon="inline-start" />
          Extra allowance
        </Button>
        <Confirm
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${limit.name}`}>
              <Trash2 />
            </Button>
          }
          title={`Delete ${limit.name}?`}
          description="Its extra allowances go with it. What was printed stays recorded, and other limits keep counting it."
          confirmLabel="Delete limit"
          destructive
          onConfirm={() => remove.mutateAsync(limit.id)}
        />
      </div>
    </li>
  )
}

/** Usage > Limits (admins): every limit, with editing and extra allowances in dialogs. */
export default function LimitsTab({ ws }: SlotProps['usageTab']) {
  const limits = useLimits(ws)
  const prices = usePrices(ws)
  const names = namesFrom(usePolicySources(ws))
  const [editing, setEditing] = useState<{ limit?: PrintLimitView } | null>(null)
  const [extraFor, setExtraFor] = useState<string | null>(null)
  const extra = limits.data?.find((l) => l.id === extraFor)
  const add = (
    <Button onClick={() => setEditing({})}>
      <Plus data-icon="inline-start" />
      New limit
    </Button>
  )
  return (
    <div className="flex flex-col gap-6">
      <QueryState query={limits}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Gauge}
              title="No limits yet"
              description="Cap how much each person, group, device or printer prints in a day, week, month, quarter or year. A job that would go over is refused, or prints with a warning."
              action={add}
            />
          ) : (
            prices.data && (
              <Section
                id="limits"
                title="Limits"
                description="Every job is checked against each limit that counts it, together with everything already printed or waiting this cycle."
                actions={add}
                flush
              >
                <ul>
                  {list.map((limit) => (
                    <LimitRow
                      key={limit.id}
                      ws={ws}
                      limit={limit}
                      prices={prices.data}
                      names={names}
                      onEdit={() => setEditing({ limit })}
                      onExtra={() => setExtraFor(limit.id)}
                    />
                  ))}
                </ul>
              </Section>
            )
          )
        }
      </QueryState>
      {editing && <LimitDialog key={editing.limit?.id ?? 'new'} ws={ws} limit={editing.limit} open onOpenChange={(open) => !open && setEditing(null)} />}
      {extra && prices.data && (
        <AllowanceDialog key={extra.id} ws={ws} limit={extra} prices={prices.data} names={names} open onOpenChange={(open) => !open && setExtraFor(null)} />
      )}
    </div>
  )
}
