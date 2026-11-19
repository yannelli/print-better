import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import type { Printer } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useUpdatePrinter } from '@/hooks/printers'

export function RenameDialog({
  ws,
  printer,
  open,
  onOpenChange,
}: {
  ws: string
  printer: Printer
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const update = useUpdatePrinter(ws)
  const [name, setName] = useState(printer.name)
  const [location, setLocation] = useState(printer.location ?? '')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    update.mutate(
      { id: printer.id, patch: { name: name.trim(), location: location.trim() || null } },
      {
        onSuccess: () => {
          toast.success('Printer details saved')
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Name and place</DialogTitle>
            <DialogDescription>Pick names people will recognize, like “Kitchen printer”.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-location`}>Where it is</FieldLabel>
            <Input
              id={`${id}-location`}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Upstairs office"
              maxLength={80}
            />
            <FieldDescription>Optional. Helps people pick the right printer.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
