import { type FormEvent, useId, useState } from 'react'
import type { BudgetInput, BudgetView, CostCenter } from '@shared/enterprise'
import type { Cycle, OverAction } from '@shared/usage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ChoiceSelect } from '@/routes/settings/fields'
import { CycleField } from '../usage/cycle-field'
import { MoneyInput } from '../usage/money-input'
import { moneyText, parseMoney } from '../usage/words'
import { enterpriseApi } from './api'
import { useEnterpriseMutation } from './hooks'
import { OVER_ACTIONS } from './words'

type Unit = BudgetInput['unit']

const UNITS: { value: Unit; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'pages', label: 'Pages' },
]

function parseAmount(unit: Unit, text: string): number | null {
  if (unit === 'cost') return parseMoney(text)
  const n = Number(text.trim())
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null
}

/** Add a budget to a cost center, or change one (`budget`). */
export function BudgetDialog({
  ws,
  budget,
  centers,
  currency,
  onOpenChange,
}: {
  ws: string
  budget?: BudgetView
  centers: CostCenter[]
  currency: string
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const [costCenterId, setCostCenterId] = useState(budget?.costCenterId ?? centers.find((c) => c.active)?.id ?? '')
  const [unit, setUnit] = useState<Unit>(budget?.unit ?? 'cost')
  const [amount, setAmount] = useState(budget ? (budget.unit === 'cost' ? moneyText(budget.amount) : String(budget.amount)) : '')
  const [cycle, setCycle] = useState<Cycle>(budget?.cycle ?? { kind: 'month', startDay: 1 })
  const [action, setAction] = useState<OverAction>(budget?.action ?? 'block')
  const parsed = parseAmount(unit, amount)
  const save = useEnterpriseMutation(
    ws,
    (input: BudgetInput) => (budget ? enterpriseApi.updateBudget(ws, budget.id, { unit, amount: input.amount, cycle, action }) : enterpriseApi.createBudget(ws, input)),
    budget ? 'Budget saved' : 'Budget added',
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (parsed !== null) save.mutate({ costCenterId, unit, amount: parsed, cycle, action }, { onSuccess: () => onOpenChange(false) })
  }
  const choices = centers.filter((c) => c.active || c.id === costCenterId).map((c) => ({ value: c.id, label: c.name }))
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{budget ? 'Edit budget' : 'New budget'}</DialogTitle>
            <DialogDescription>Counts every job charged to the cost center, on every printer.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-center`}>Cost center</FieldLabel>
            <ChoiceSelect id={`${id}-center`} value={costCenterId} onChange={setCostCenterId} options={choices} disabled={!!budget} className="sm:w-full" />
          </Field>
          <div className="grid gap-6 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-unit`}>Count</FieldLabel>
              <ChoiceSelect id={`${id}-unit`} value={unit} onChange={setUnit} options={UNITS} className="sm:w-full" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-amount`}>Budget</FieldLabel>
              {unit === 'cost' ? (
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={currency} invalid={amount !== '' && parsed === null} />
              ) : (
                <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular w-28" aria-invalid={(amount !== '' && parsed === null) || undefined} />
              )}
            </Field>
          </div>
          {amount !== '' && parsed === null && <FieldError>{unit === 'cost' ? 'Enter an amount such as 250 or 99.50.' : 'Enter a whole number of pages.'}</FieldError>}
          <Field>
            <FieldLabel htmlFor={`${id}-cycle`}>Starts over</FieldLabel>
            <CycleField id={`${id}-cycle`} value={cycle} onChange={setCycle} />
            <FieldDescription>At midnight in the workspace time zone.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-action`}>When a job would go over</FieldLabel>
            <ChoiceSelect id={`${id}-action`} value={action} onChange={setAction} options={OVER_ACTIONS} className="sm:w-full" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={parsed === null || !costCenterId || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              {budget ? 'Save' : 'Add budget'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
