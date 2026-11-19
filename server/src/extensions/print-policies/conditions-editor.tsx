import { Plus, X } from 'lucide-react'
import type { PolicySubject, RuleConditions } from '@shared/policies'
import { Button, buttonVariants } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ConditionField } from './condition-fields'
import type { PolicySources } from './names'
import { CONDITIONS, NEW_CONDITION, without } from './rule-form'

/** The conditions a rule has, each with its editor, and a menu to add the others. */
export function ConditionsEditor({ value, onChange, sources, names }: {
  value: RuleConditions
  onChange: (c: RuleConditions) => void
  sources: PolicySources
  names: (s: PolicySubject) => string
}) {
  const set = CONDITIONS.filter((c) => c.key in value)
  const unset = CONDITIONS.filter((c) => !(c.key in value))
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[0.9375rem] font-medium">When</legend>
      {set.length === 0 && <p className="text-sm text-muted-foreground">Every job, until you add a condition. Jobs must match every condition you add.</p>}
      {set.map((c) => (
        <div key={c.key} className="flex flex-col gap-2 rounded-2xl border p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{c.label}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${c.label}`} onClick={() => onChange(without(value, c.key))}>
              <X />
            </Button>
          </div>
          <ConditionField field={c.key} conditions={value} onChange={onChange} sources={sources} names={names} />
        </div>
      ))}
      {unset.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start')}>
            <Plus data-icon="inline-start" />
            Add a condition
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {unset.map((c) => (
              <DropdownMenuItem key={c.key} onClick={() => onChange({ ...value, [c.key]: NEW_CONDITION[c.key] })}>
                {c.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </fieldset>
  )
}
