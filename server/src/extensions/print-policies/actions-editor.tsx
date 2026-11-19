import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import type { RuleAction } from '@shared/policies'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { PolicySources } from './names'
import { NumberInput } from './number-input'
import { ACTION_TYPES, NEW_ACTION } from './rule-form'

function Params({ action, onChange, sources }: { action: RuleAction; onChange: (a: RuleAction) => void; sources: PolicySources }) {
  switch (action.type) {
    case 'block':
    case 'note':
      return (
        <Input
          aria-label={action.type === 'block' ? 'Message the sender sees' : 'Note'}
          value={action.message}
          onChange={(e) => onChange({ ...action, message: e.target.value })}
          maxLength={200}
          placeholder={action.type === 'block' ? 'Send jobs over 50 pages to the copier.' : 'Printed two-sided to save paper.'}
        />
      )
    case 'max-copies':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          At most
          <NumberInput label="Copies" value={action.copies} onChange={(copies) => onChange({ ...action, copies: copies ?? 0 })} />
          copies
        </div>
      )
    case 'redirect':
      return (
        <ChoiceSelect
          ariaLabel="Printer"
          value={action.printerId}
          onChange={(printerId) => onChange({ ...action, printerId })}
          options={sources.printers.map((p) => ({ value: p.id, label: p.name }))}
        />
      )
    default:
      return null
  }
}

/** A rule's actions, run in order; approval and release are offered only with Enterprise controls on. */
export function ActionsEditor({ value, onChange, sources, enterprise }: {
  value: RuleAction[]
  onChange: (a: RuleAction[]) => void
  sources: PolicySources
  enterprise: boolean
}) {
  const types = ACTION_TYPES.filter((t) => enterprise || (t.value !== 'approval' && t.value !== 'release') || value.some((a) => a.type === t.value))
  const replace = (i: number, a: RuleAction) => onChange(value.map((x, j) => (j === i ? a : x)))
  const move = (i: number, by: number) => {
    const next = value.slice()
    next.splice(i + by, 0, ...next.splice(i, 1))
    onChange(next)
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[0.9375rem] font-medium">Then</legend>
      {value.map((action, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-2xl border p-3.5">
          <div className="flex items-center gap-1">
            <ChoiceSelect ariaLabel={`Action ${i + 1}`} value={action.type} onChange={(type) => replace(i, NEW_ACTION[type])} options={types} className="sm:w-60" />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove action" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
          <Params action={action} onChange={(a) => replace(i, a)} sources={sources} />
        </div>
      ))}
      {value.length < 10 && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...value, NEW_ACTION.note])}>
          <Plus data-icon="inline-start" />
          Add an action
        </Button>
      )}
    </fieldset>
  )
}
