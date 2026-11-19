import { type FormEvent, useState } from 'react'
import type { Passkey } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useRenamePasskey } from '@/hooks/account'

export function RenameDialog({ passkey }: { passkey: Passkey }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(passkey.name)
  const rename = useRenamePasskey()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    rename.mutate({ id: passkey.id, name: name.trim() }, { onSuccess: () => setOpen(false) })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setName(passkey.name)
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`passkey-name-${passkey.id}`}>Name</FieldLabel>
            <Input
              id={`passkey-name-${passkey.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoComplete="off"
              required
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || rename.isPending}>
              {rename.isPending && <Spinner data-icon="inline-start" />}
              Save name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
