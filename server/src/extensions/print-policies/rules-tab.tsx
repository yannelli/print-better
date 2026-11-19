import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PrintRule } from '@shared/policies'
import { actionPhrase, conditionPhrases, type NameOf } from '@shared/policy-text'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { SlotProps } from '../registry'
import { useDeleteRule, usePolicySources, useReorderRules, useRules, useUpdateRule } from './hooks'
import { namesFrom, sentence } from './names'
import { RuleDialog } from './rule-dialog'

function RuleRow({ ws, rule, index, rules, names, onEdit }: { ws: string; rule: PrintRule; index: number; rules: PrintRule[]; names: NameOf; onEdit: () => void }) {
  const update = useUpdateRule(ws)
  const remove = useDeleteRule(ws)
  const reorder = useReorderRules(ws)
  const when = conditionPhrases(rule.conditions, names).map(sentence)
  const move = (by: number) => {
    const next = rules.slice()
    next.splice(index + by, 0, ...next.splice(index, 1))
    reorder.mutate(next)
  }
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <span aria-hidden className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground tabular-nums sm:flex">
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={rule.enabled ? 'text-[0.9375rem] font-medium' : 'text-[0.9375rem] font-medium text-muted-foreground'}>{rule.name}</span>
        <span className="text-sm text-muted-foreground">When: {when.length ? when.join(' · ') : 'Every job'}</span>
        <span className="text-sm text-muted-foreground">
          Then: {rule.actions.map((a) => actionPhrase(a, names)).join(' · ')}
          {rule.exemptAdmins && ". Doesn't apply to owners and admins"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          checked={rule.enabled}
          aria-label={`${rule.name} is ${rule.enabled ? 'on' : 'off'}`}
          disabled={update.isPending}
          onCheckedChange={(enabled) => update.mutate({ id: rule.id, input: { enabled } })}
        />
        <Button variant="ghost" size="icon-sm" aria-label={`Move ${rule.name} up`} disabled={index === 0 || reorder.isPending} onClick={() => move(-1)}>
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Move ${rule.name} down`} disabled={index === rules.length - 1 || reorder.isPending} onClick={() => move(1)}>
          <ArrowDown />
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
        <Confirm
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${rule.name}`}>
              <Trash2 />
            </Button>
          }
          title={`Delete ${rule.name}?`}
          description="Jobs sent from now on skip it. Jobs it already changed keep their notes."
          confirmLabel="Delete rule"
          destructive
          onConfirm={() => remove.mutateAsync(rule.id)}
        />
      </div>
    </li>
  )
}

/** Usage > Rules (admins): rules top to bottom, the order they run in, with editing in a dialog. */
export default function RulesTab({ ws }: SlotProps['usageTab']) {
  const rules = useRules(ws)
  const names = namesFrom(usePolicySources(ws))
  const [editing, setEditing] = useState<{ rule?: PrintRule } | null>(null)
  const add = (
    <Button onClick={() => setEditing({})}>
      <Plus data-icon="inline-start" />
      New rule
    </Button>
  )
  return (
    <div className="flex flex-col gap-6">
      <QueryState query={rules}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No rules yet"
              description="Rules check every job before it prints. Block very large jobs, print two-sided, send color jobs to another printer, or add a note."
              action={add}
            />
          ) : (
            <Section
              id="rules"
              title="Rules"
              description="Rules run top to bottom. Each one whose conditions all match applies its actions, and a rule that blocks stops the job right there."
              actions={add}
              flush
            >
              <ol>
                {list.map((rule, i) => (
                  <RuleRow key={rule.id} ws={ws} rule={rule} index={i} rules={list} names={names} onEdit={() => setEditing({ rule })} />
                ))}
              </ol>
            </Section>
          )
        }
      </QueryState>
      {editing && <RuleDialog key={editing.rule?.id ?? 'new'} ws={ws} rule={editing.rule} open onOpenChange={(open) => !open && setEditing(null)} />}
    </div>
  )
}
