import { UserPlus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import type { Invite, Role } from '@shared/types'
import { CopyField } from '@/components/copy'
import { OptionCards } from '@/components/option-cards'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useInstance } from '@/hooks/auth'
import { useCreateInvite } from '@/hooks/members'
import { useRole } from '@/hooks/workspace'
import { date } from '@/lib/format'
import { ROLE_HELP, ROLE_NAMES } from '@/lib/words'

function InviteResult({ url, invite, emailed }: { url: string; invite: Invite; emailed: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <CopyField label="Invite link" value={url} multiline />
      <p className="text-[0.9375rem]">
        Send this link to them by text or email. It works once and expires on {date(invite.expiresAt)}.
        {emailed && ` We also emailed it to ${invite.email}.`}
      </p>
    </div>
  )
}

export function InviteDialog({ ws }: { ws: string }) {
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>('member')
  const [email, setEmail] = useState('')
  const create = useCreateInvite(ws)
  const instance = useInstance().data
  const myRole = useRole()
  const roles: Role[] = myRole === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin']

  const reset = () => {
    create.reset()
    setRole('member')
    setEmail('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate({ role, email: email.trim() || undefined })
  }

  const result = create.data
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button />}>
        <UserPlus data-icon="inline-start" />
        Invite someone
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{result ? 'Invite ready' : 'Invite someone'}</DialogTitle>
          <DialogDescription>
            {result ? 'They open the link, create an account or sign in, and join right away.' : 'You will get a link to send them.'}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <InviteResult url={result.url} invite={result.invite} emailed={!!result.invite.email && !!instance?.emailEnabled} />
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Invite someone else
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-3 text-[0.9375rem] font-medium">What can they do?</legend>
              <OptionCards<Role>
                label="Role"
                columns={roles.length === 3 ? 3 : 2}
                value={role}
                onChange={setRole}
                options={roles.map((r) => ({ value: r, label: ROLE_NAMES[r], description: ROLE_HELP[r] }))}
              />
            </fieldset>
            <Field>
              <FieldLabel htmlFor="invite-email">Their email (optional)</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
              <FieldDescription>
                {instance?.emailEnabled
                  ? 'We will also email the link to them.'
                  : 'For your records. This server doesn’t send email, so you share the link yourself.'}
              </FieldDescription>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Spinner data-icon="inline-start" />}
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
