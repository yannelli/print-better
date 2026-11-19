import { type FormEvent, useId, useState } from 'react'
import type { LimitAdjustment, PrintLimitView } from '@shared/policies'
import type { NameOf } from '@shared/policy-text'
import type { Prices } from '@shared/usage'
import { formatAmount } from '@shared/usage-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ChoiceSelect } from '@/routes/settings/fields'
import { MoneyInput } from '../usage/money-input'
import { resetDay } from '../usage/words'
import { useAddAllowance, useAllowances } from './hooks'
import { parseAmount } from './limit-form'
import { sentence } from './names'

type Subject = NonNullable<LimitAdjustment['subject']>
const keyOf = (s: Subject) => `${s.type}:${s.id}`

function Given({ list, limit, prices, names }: { list: LimitAdjustment[]; limit: PrintLimitView; prices: Prices; names: NameOf }) {
  if (list.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[0.9375rem] font-medium">Already given this cycle</h3>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {list.map((a) => (
          <li key={a.id}>
            {formatAmount(limit.unit, a.amount, prices.currency)} more{a.subject ? ` for ${names(a.subject.type, a.subject.id)}` : ''}
            {a.note ? `: ${a.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A one-off extra amount for the current cycle, for one count of a limit. */
export function AllowanceDialog({ ws, limit, prices, names, open, onOpenChange }: {
  ws: string
  limit: PrintLimitView
  prices: Prices
  names: NameOf
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const add = useAddAllowance(ws)
  const given = useAllowances(ws, limit.id).data ?? []
  const counts = limit.usage.filter((u): u is typeof u & { subject: Subject } => u.subject !== null && u.subject.type !== 'group')
  const perSubject = ['each-member', 'each-device', 'group-each'].includes(limit.scope.type)
  const [who, setWho] = useState(perSubject && counts[0] ? keyOf(counts[0].subject) : '')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const value = parseAmount(limit.unit, amount)
  const subject = counts.find((u) => keyOf(u.subject) === who)?.subject
  const ends = limit.usage[0] ? `It ends when the count starts over on ${resetDay(limit.usage[0].end, prices.timeZone)}.` : 'It ends when the count starts over.'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!value || (perSubject && !subject)) return
    const input = { amount: value, ...(perSubject && subject ? { subject } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
    add.mutate({ id: limit.id, input }, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Extra allowance for {limit.name}</DialogTitle>
            <DialogDescription>Adds to this cycle only. {ends}</DialogDescription>
          </DialogHeader>
          {perSubject && (
            <Field>
              <FieldLabel htmlFor={`${id}-who`}>For</FieldLabel>
              {counts.length === 0 ? (
                <FieldDescription>Nobody this limit counts yet.</FieldDescription>
              ) : (
                <ChoiceSelect
                  id={`${id}-who`}
                  value={who}
                  onChange={setWho}
                  options={counts.map((u) => ({ value: keyOf(u.subject), label: u.subjectName ?? sentence(names(u.subject.type, u.subject.id)) }))}
                  className="sm:w-full"
                />
              )}
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-amount`}>How much more</FieldLabel>
            {limit.unit === 'cost' ? (
              <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={prices.currency} invalid={!!amount && !value} />
            ) : (
              <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus className="tabular sm:w-40" />
            )}
            <FieldDescription>In {limit.unit === 'cost' ? prices.currency : limit.unit}.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>Note</FieldLabel>
            <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Exam week" />
            <FieldDescription>Optional. Kept in the audit log.</FieldDescription>
          </Field>
          <Given list={given} limit={limit} prices={prices} names={names} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value || (perSubject && !subject) || add.isPending}>
              {add.isPending && <Spinner data-icon="inline-start" />}
              Add extra
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
