import { type FormEvent, useState } from 'react'
import { useLocation } from 'wouter'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useCreateWorkspace } from '@/hooks/workspace'
import { wsHref } from './app-actions'

export function NewWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('')
  const create = useCreateWorkspace()
  const [, navigate] = useLocation()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate(name.trim(), {
      onSuccess: (workspace) => {
        onOpenChange(false)
        setName('')
        navigate(wsHref(workspace.id, '/devices/add'))
      },
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>A workspace keeps its own printers, devices and people. Use one per home or office.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-ws-name">Name</FieldLabel>
            <Input id="new-ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home, Office, Grandma’s house" required autoFocus maxLength={80} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
