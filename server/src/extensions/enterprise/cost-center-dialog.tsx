import { type FormEvent, useId, useState } from 'react'
import type { CostCenter, CostCenterInput } from '@shared/enterprise'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { enterpriseApi } from './api'
import { useEnterpriseMutation } from './hooks'

/** Add a cost center, or change one (`center`). */
export function CostCenterDialog({ ws, center, onOpenChange }: { ws: string; center?: CostCenter; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const [name, setName] = useState(center?.name ?? '')
  const [code, setCode] = useState(center?.code ?? '')
  const [active, setActive] = useState(center?.active ?? true)
  const save = useEnterpriseMutation(
    ws,
    (input: CostCenterInput) => (center ? enterpriseApi.updateCostCenter(ws, center.id, input) : enterpriseApi.createCostCenter(ws, input)),
    center ? 'Cost center saved' : 'Cost center added',
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({ name: name.trim(), code: code.trim() || null, ...(center ? { active } : {}) }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{center ? center.name : 'New cost center'}</DialogTitle>
            <DialogDescription>A department, project, or client that printing is charged to.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Marketing" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-code`}>Code</FieldLabel>
            <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} placeholder="MKT-100" />
            <FieldDescription>Optional. People and AI assistants can type it instead of the name.</FieldDescription>
          </Field>
          {center && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor={`${id}-active`}>Active</FieldLabel>
                <FieldDescription>Inactive cost centers can’t be chosen, and keep their history.</FieldDescription>
              </FieldContent>
              <Switch id={`${id}-active`} checked={active} onCheckedChange={setActive} />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              {center ? 'Save' : 'Add cost center'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
