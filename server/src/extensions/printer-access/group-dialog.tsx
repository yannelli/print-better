import { type FormEvent, useId, useState } from 'react'
import type { Group } from '@shared/access'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useCreateGroup, useUpdateGroup } from './hooks'

/** Create a group, or rename and describe one (`group`). */
export function GroupDialog({ ws, group, open, onOpenChange }: { ws: string; group?: Group; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const create = useCreateGroup(ws)
  const update = useUpdateGroup(ws)
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const pending = create.isPending || update.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input = { name: name.trim(), description: description.trim() || null }
    const done = { onSuccess: () => onOpenChange(false) }
    if (group) update.mutate({ id: group.id, input }, done)
    else create.mutate(input, done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{group ? 'Name and description' : 'New group'}</DialogTitle>
            <DialogDescription>
              {group ? 'People see this name when access is given to the group.' : 'Add people and devices to it next, then give the group access to printers.'}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Front office" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
            <Input
              id={`${id}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={160}
              placeholder="Reception and the shared front desk computer"
            />
            <FieldDescription>Optional.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {group ? 'Save' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
