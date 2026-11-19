import { type FormEvent, useId, useState } from 'react'
import type { PrintLimit } from '@shared/policies'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useExtensionActive } from '@/hooks/extensions'
import { ChoiceSelect } from '@/routes/settings/fields'
import { CycleField } from '../usage/cycle-field'
import { usePrices } from '../usage/hooks'
import { MoneyInput } from '../usage/money-input'
import { useCreateLimit, usePolicySources, useUpdateLimit } from './hooks'
import { ACTIONS, draftOf, inputOf, type LimitDraft, parseAmount, type Named, SCOPES, UNITS } from './limit-form'

const PICK_WORDS: Record<Named, { label: string; none: string }> = {
  user: { label: 'Member', none: 'No members yet' },
  group: { label: 'Group', none: 'No groups yet. Add them under Members > Groups.' },
  client: { label: 'Device', none: 'No devices yet' },
  printer: { label: 'Printer', none: 'No printers added yet' },
}

/** Create a limit, or edit one (`limit`). */
export function LimitDialog({ ws, limit, open, onOpenChange }: { ws: string; limit?: PrintLimit; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const create = useCreateLimit(ws)
  const update = useUpdateLimit(ws)
  const sources = usePolicySources(ws)
  const currency = usePrices(ws).data?.currency ?? 'USD'
  const approvals = useExtensionActive(ws, 'enterprise')
  const [d, setD] = useState<LimitDraft>(() => draftOf(limit))
  const edit = (patch: Partial<LimitDraft>) => setD((current) => ({ ...current, ...patch }))
  const input = inputOf(d)
  const pending = create.isPending || update.isPending
  const scope = SCOPES.find((s) => s.value === d.scope)
  const scopes = SCOPES.filter((s) => !s.needsGroups || sources.groups.length > 0 || s.value === limit?.scope.type)
  const actions = ACTIONS.filter((a) => a.value !== 'approval' || approvals || limit?.action === 'approval')
  const choices = scope?.picks ? subjectChoices(scope.picks, sources) : []

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!input) return
    const done = { onSuccess: () => onOpenChange(false) }
    if (limit) update.mutate({ id: limit.id, input }, done)
    else create.mutate(input, done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{limit ? `Edit ${limit.name}` : 'New limit'}</DialogTitle>
            <DialogDescription>Counts start over at midnight in the workspace time zone. Jobs still waiting or printing count too.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={d.name} onChange={(e) => edit({ name: e.target.value })} required maxLength={100} placeholder="Monthly pages" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-scope`}>Who it counts</FieldLabel>
            <ChoiceSelect id={`${id}-scope`} value={d.scope} onChange={(scope) => edit({ scope, subject: '' })} options={scopes} className="sm:w-full" />
          </Field>
          {scope?.picks && (
            <Field>
              <FieldLabel htmlFor={`${id}-subject`}>{PICK_WORDS[scope.picks].label}</FieldLabel>
              {choices.length === 0 ? (
                <FieldDescription>{PICK_WORDS[scope.picks].none}</FieldDescription>
              ) : (
                <ChoiceSelect id={`${id}-subject`} value={d.subject} onChange={(subject) => edit({ subject })} options={choices} className="sm:w-full" />
              )}
            </Field>
          )}
          <div className="grid gap-6 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-unit`}>What it counts</FieldLabel>
              <ChoiceSelect id={`${id}-unit`} value={d.unit} onChange={(unit) => edit({ unit, amount: '' })} options={UNITS} className="sm:w-full" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-amount`}>Amount</FieldLabel>
              {d.unit === 'cost' ? (
                <MoneyInput id={`${id}-amount`} value={d.amount} onChange={(amount) => edit({ amount })} currency={currency} invalid={!!d.amount && parseAmount(d.unit, d.amount) === null} />
              ) : (
                <Input id={`${id}-amount`} inputMode="numeric" value={d.amount} onChange={(e) => edit({ amount: e.target.value })} required className="tabular" />
              )}
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`${id}-cycle`}>Starts over</FieldLabel>
            <CycleField id={`${id}-cycle`} value={d.cycle} onChange={(cycle) => edit({ cycle })} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-action`}>When a job would go over</FieldLabel>
            <ChoiceSelect id={`${id}-action`} value={d.action} onChange={(action) => edit({ action })} options={actions} className="sm:w-full" />
          </Field>
          <label className="flex items-start gap-3 rounded-2xl border p-3.5">
            <Checkbox className="mt-0.5" checked={d.exemptAdmins} onCheckedChange={(exemptAdmins) => edit({ exemptAdmins })} />
            <span className="flex flex-col gap-0.5">
              <span className="text-[0.9375rem] font-medium">Doesn't apply to owners and admins</span>
              <span className="text-sm text-muted-foreground">Their jobs still count toward shared counts, such as a printer's or the workspace's.</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[0.9375rem] font-medium">On</span>
            <Switch checked={d.enabled} onCheckedChange={(enabled) => edit({ enabled })} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!input || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {limit ? 'Save' : 'Add limit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function subjectChoices(picks: Named, s: ReturnType<typeof usePolicySources>) {
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
  switch (picks) {
    case 'user':
      return s.members.map((m) => ({ value: m.userId, label: m.name, description: `@${m.username}` })).sort(byName)
    case 'group':
      return s.groups.map((g) => ({ value: g.id, label: g.name })).sort(byName)
    case 'client':
      return s.clients.map((c) => ({ value: c.id, label: c.name })).sort(byName)
    case 'printer':
      return s.printers.map((p) => ({ value: p.id, label: p.name }))
  }
}
