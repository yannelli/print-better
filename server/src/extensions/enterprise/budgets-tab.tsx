import { PiggyBank, Plus } from 'lucide-react'
import { useState } from 'react'
import type { BudgetView, CostCenter } from '@shared/enterprise'
import type { Prices } from '@shared/usage'
import { formatAmount } from '@shared/usage-text'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SlotProps } from '../registry'
import { cycleLabel } from '../usage/cycles'
import { usePrices } from '../usage/hooks'
import { meterLine } from '../usage/words'
import { enterpriseApi } from './api'
import { BudgetDialog } from './budget-dialog'
import { useBudgets, useCostCenters, useEnterpriseMutation } from './hooks'
import { OVER_ACTIONS } from './words'

function BudgetRow({ ws, budget, center, prices, onEdit }: { ws: string; budget: BudgetView; center?: CostCenter; prices: Prices; onEdit: () => void }) {
  const toggle = useEnterpriseMutation(ws, (enabled: boolean) => enterpriseApi.updateBudget(ws, budget.id, { enabled }), 'Budget saved')
  const remove = useEnterpriseMutation(ws, () => enterpriseApi.deleteBudget(ws, budget.id), 'Budget deleted')
  const { usage } = budget
  const name = center?.name ?? 'A deleted cost center'
  const share = usage.amount > 0 ? Math.min(100, (usage.used / usage.amount) * 100) : 100
  const over = usage.used >= usage.amount
  const action = OVER_ACTIONS.find((a) => a.value === budget.action)?.label
  return (
    <li className={cn('flex flex-col gap-4 border-b px-5 py-5 last:border-b-0 sm:px-6', !budget.enabled && 'text-muted-foreground')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.9375rem] font-medium text-foreground">
            {name}: {formatAmount(budget.unit, budget.amount, prices.currency)}
          </span>
          <span className="text-sm text-muted-foreground">
            {cycleLabel(budget.cycle)}. Over budget: {action}.{budget.enabled ? '' : ' Off.'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch aria-label={`Budget for ${name} on`} checked={budget.enabled} onCheckedChange={(on) => toggle.mutate(on)} disabled={toggle.isPending} />
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Confirm
            trigger={
              <Button variant="ghost" size="sm">
                Delete
              </Button>
            }
            title={`Delete the budget for ${name}?`}
            description="Jobs stop counting against it. Their usage stays in reports."
            confirmLabel="Delete"
            destructive
            onConfirm={() => remove.mutateAsync(undefined)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Progress value={share} aria-label={`${name} budget used`} className={cn(over && '[&_[data-slot=progress-indicator]]:bg-bad')} />
        <span className={cn('text-sm', over ? 'text-on-bad-container' : 'text-muted-foreground')}>
          {formatAmount(budget.unit, usage.used, prices.currency)} used. {meterLine(usage, prices.currency, prices.timeZone)}.
        </span>
      </div>
    </li>
  )
}

/** Usage > Budgets (admins): each cost center's budgets and how much of each is used. */
export default function BudgetsTab({ ws }: SlotProps['usageTab']) {
  const budgets = useBudgets(ws)
  const centers = useCostCenters(ws).data?.costCenters
  const prices = usePrices(ws).data
  const [editing, setEditing] = useState<{ budget?: BudgetView } | null>(null)
  const canAdd = !!centers?.some((c) => c.active)
  const add = (
    <Button onClick={() => setEditing({})} disabled={!canAdd}>
      <Plus data-icon="inline-start" />
      New budget
    </Button>
  )
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <QueryState query={budgets}>
        {(list) =>
          !prices || !centers ? null : list.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No budgets yet"
              description={canAdd ? 'Set how much each cost center can print in a week, month, quarter, or year.' : 'Add a cost center first, then give it a budget.'}
              action={add}
            />
          ) : (
            <Section id="budgets" title="Budgets" description="Every job charged to a cost center counts, on every printer." actions={add} flush>
              <ul>
                {list.map((budget) => (
                  <BudgetRow
                    key={budget.id}
                    ws={ws}
                    budget={budget}
                    center={centers.find((c) => c.id === budget.costCenterId)}
                    prices={prices}
                    onEdit={() => setEditing({ budget })}
                  />
                ))}
              </ul>
            </Section>
          )
        }
      </QueryState>
      {editing && centers && prices && (
        <BudgetDialog
          key={editing.budget?.id ?? 'new'}
          ws={ws}
          budget={editing.budget}
          centers={centers}
          currency={prices.currency}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </div>
  )
}
