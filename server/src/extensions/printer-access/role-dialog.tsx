import { type FormEvent, useId, useState } from 'react'
import { PRINTER_PERMISSIONS, type PrinterPermission, type PrinterRole, withImplied } from '@shared/access'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { PERMISSION_WORDS } from '@/lib/words'
import { useCreateRole, useUpdateRole } from './hooks'

/** Why a permission is ticked and locked: another chosen permission includes it. */
function impliedBy(permission: PrinterPermission, chosen: PrinterPermission[]): PrinterPermission | null {
  if (permission === 'view') return chosen.find((p) => p !== 'view') ?? null
  if (permission === 'jobs.read' && chosen.includes('jobs.manage')) return 'jobs.manage'
  return null
}

/** Create a custom role, or edit one (`role`). Everyone holding it changes at once. */
export function RoleDialog({ ws, role, open, onOpenChange }: { ws: string; role?: PrinterRole; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const create = useCreateRole(ws)
  const update = useUpdateRole(ws)
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [chosen, setChosen] = useState<PrinterPermission[]>(role?.permissions ?? ['view', 'print'])
  const pending = create.isPending || update.isPending
  const effective = withImplied(chosen)

  const toggle = (permission: PrinterPermission, on: boolean) =>
    setChosen((list) => (on ? [...list, permission] : list.filter((p) => p !== permission)))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input = { name: name.trim(), description: description.trim() || null, permissions: effective }
    const done = { onSuccess: () => onOpenChange(false) }
    if (role) update.mutate({ id: role.id, input }, done)
    else create.mutate(input, done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
            <DialogDescription>
              {role ? 'Everyone who has this role gets the change right away.' : 'A role is a set of things people can do with a printer.'}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Front desk" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
            <Input
              id={`${id}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={160}
              placeholder="Prints, sees only their own jobs"
            />
            <FieldDescription>Optional. Shown when someone picks a role.</FieldDescription>
          </Field>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-[0.9375rem] font-medium">What can people with this role do?</legend>
            {PRINTER_PERMISSIONS.map((permission) => {
              const lockedBy = impliedBy(permission, chosen)
              const words = PERMISSION_WORDS[permission]
              return (
                <label key={permission} className="flex items-start gap-3 rounded-2xl border p-3.5 has-disabled:opacity-70">
                  <Checkbox
                    className="mt-0.5"
                    checked={effective.includes(permission)}
                    disabled={!!lockedBy}
                    onCheckedChange={(on) => toggle(permission, on)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[0.9375rem] font-medium">{words.label}</span>
                    <span className="text-sm text-muted-foreground">
                      {lockedBy ? `Included with “${PERMISSION_WORDS[lockedBy].label}”` : words.help}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || effective.length === 0 || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {role ? 'Save role' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
