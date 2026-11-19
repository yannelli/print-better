import { type FormEvent, useId, useState } from 'react'
import type { PolicySubject, PrintRule } from '@shared/policies'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useExtensionActive } from '@/hooks/extensions'
import { ActionsEditor } from './actions-editor'
import { ConditionsEditor } from './conditions-editor'
import { useCreateRule, usePolicySources, useUpdateRule } from './hooks'
import { namesFrom, sentence } from './names'
import { draftOf, inputOf, problemOf, type RuleDraft } from './rule-form'

/** Create a rule (added at the bottom), or edit one (`rule`). */
export function RuleDialog({ ws, rule, open, onOpenChange }: { ws: string; rule?: PrintRule; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const create = useCreateRule(ws)
  const update = useUpdateRule(ws)
  const sources = usePolicySources(ws)
  const names = namesFrom(sources)
  const enterprise = useExtensionActive(ws, 'enterprise')
  const [d, setD] = useState<RuleDraft>(() => draftOf(rule))
  const edit = (patch: Partial<RuleDraft>) => setD((current) => ({ ...current, ...patch }))
  const problem = problemOf(d)
  const pending = create.isPending || update.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (problem) return
    const done = { onSuccess: () => onOpenChange(false) }
    if (rule) update.mutate({ id: rule.id, input: inputOf(d) }, done)
    else create.mutate(inputOf(d), done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{rule ? `Edit ${rule.name}` : 'New rule'}</DialogTitle>
            <DialogDescription>
              {rule ? 'Changes apply to jobs sent from now on.' : 'New rules go at the bottom. Rules run top to bottom, and each sees the job as the ones above left it.'}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={d.name} onChange={(e) => edit({ name: e.target.value })} required maxLength={100} placeholder="Big jobs on both sides" autoFocus />
          </Field>
          <ConditionsEditor value={d.conditions} onChange={(conditions) => edit({ conditions })} sources={sources} names={(s: PolicySubject) => sentence(names(s.type, s.id))} />
          <ActionsEditor value={d.actions} onChange={(actions) => edit({ actions })} sources={sources} enterprise={enterprise} />
          <label className="flex items-start gap-3 rounded-2xl border p-3.5">
            <Checkbox className="mt-0.5" checked={d.exemptAdmins} onCheckedChange={(exemptAdmins) => edit({ exemptAdmins })} />
            <span className="text-[0.9375rem] font-medium">Doesn't apply to owners and admins</span>
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[0.9375rem] font-medium">On</span>
            <Switch checked={d.enabled} onCheckedChange={(enabled) => edit({ enabled })} />
          </label>
          <DialogFooter className="items-center">
            {problem && <p className="mr-auto text-sm text-muted-foreground">{problem}</p>}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!!problem || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {rule ? 'Save' : 'Add rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
