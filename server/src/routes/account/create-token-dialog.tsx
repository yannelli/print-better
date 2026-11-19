import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { CopyField } from '@/components/copy'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useCreateToken } from '@/hooks/account'
import { useSession } from '@/hooks/auth'
import { ChoiceSelect } from '../settings/fields'

const ALL = 'all'
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
]

export function CreateTokenDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [workspaceId, setWorkspaceId] = useState(ALL)
  const [expiry, setExpiry] = useState('90')
  const create = useCreateToken()
  const workspaces = useSession().data?.workspaces ?? []

  const reset = () => {
    create.reset()
    setName('')
    setWorkspaceId(ALL)
    setExpiry('90')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate({
      name: name.trim(),
      workspaceId: workspaceId === ALL ? undefined : workspaceId,
      expiresInDays: expiry === 'never' ? undefined : Number(expiry),
    })
  }

  const token = create.data?.token
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <Plus data-icon="inline-start" />
        Create a token
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{token ? 'Your new token' : 'Create an API token'}</DialogTitle>
          <DialogDescription>
            {token
              ? 'Copy it now and paste it into the tool that needs it. You won’t see it again.'
              : 'A token lets a script or app use Print Better as you. Treat it like a password.'}
          </DialogDescription>
        </DialogHeader>
        {token ? (
          <>
            <CopyField label="Token" value={token} multiline />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="token-name">Name</FieldLabel>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kitchen tablet, backup script"
                autoComplete="off"
                maxLength={64}
                required
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="token-workspace">Works in</FieldLabel>
              <ChoiceSelect
                id="token-workspace"
                value={workspaceId}
                onChange={setWorkspaceId}
                options={[{ value: ALL, label: 'All my workspaces' }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
                className="sm:w-full"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="token-expiry">Stops working after</FieldLabel>
              <ChoiceSelect id="token-expiry" value={expiry} onChange={setExpiry} options={EXPIRY} className="sm:w-full" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending && <Spinner data-icon="inline-start" />}
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
