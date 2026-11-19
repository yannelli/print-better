import { type FormEvent, useState } from 'react'
import type { Client } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useUpdateClient } from '@/hooks/devices'

export function RenameDevice({ ws, client, open, onOpenChange }: { ws: string; client: Client; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState(client.name)
  const update = useUpdateClient(ws)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    update.mutate({ id: client.id, patch: { name: name.trim() } }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(client.name)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Rename device</DialogTitle>
            <DialogDescription>Pick a name that says where it is, like “Office Mac” or “Kitchen Pi”.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rename-device">Name</FieldLabel>
            <Input id="rename-device" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === client.name || update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              Save name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
