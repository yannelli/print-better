import { useState } from 'react'
import type { User } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { CopyField } from '@/components/copy'
import { Section } from '@/components/page'
import { StatusPill } from '@/components/status'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAdminResetPassword, useAdminUsers, useDeleteAdminUser, useUpdateAdminUser } from '@/hooks/account'
import { useUser } from '@/hooks/auth'
import { date, initials } from '@/lib/format'

function UserRow({ user, isMe, onReset }: { user: User; isMe: boolean; onReset: (user: User, url: string) => void }) {
  const update = useUpdateAdminUser()
  const remove = useDeleteAdminUser()
  const reset = useAdminResetPassword()
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
          {initials(user.name)}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium">
            {user.name}
            {isMe && <span className="font-normal text-muted-foreground">(you)</span>}
            {user.isAdmin && <StatusPill status={{ label: 'Server admin', tone: 'info' }} />}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            @{user.username}
            {user.email && `, ${user.email}`}, joined {date(user.createdAt)}
          </span>
        </div>
      </div>
      {!isMe && (
        <div className="flex flex-wrap gap-2">
          <Confirm
            trigger={<Button variant="outline" size="sm">{user.isAdmin ? 'Remove admin' : 'Make admin'}</Button>}
            title={user.isAdmin ? `Remove ${user.name} as server admin?` : `Make ${user.name} a server admin?`}
            description={
              user.isAdmin
                ? 'They keep their account and workspaces but can no longer change server settings.'
                : 'Server admins can change sign-in, email and signup settings and manage every account.'
            }
            confirmLabel={user.isAdmin ? 'Remove admin' : 'Make admin'}
            onConfirm={() => update.mutateAsync({ id: user.id, isAdmin: !user.isAdmin })}
          />
          <Confirm
            trigger={<Button variant="outline" size="sm">Reset password</Button>}
            title={`Reset ${user.name}’s password?`}
            description="You get a one-time link to send them so they can choose a new password."
            confirmLabel="Get reset link"
            onConfirm={async () => onReset(user, (await reset.mutateAsync(user.id)).url)}
          />
          <Confirm
            trigger={<Button variant="ghost" size="sm">Delete account</Button>}
            title={`Delete ${user.name}’s account?`}
            description="They are removed from every workspace and can’t sign in again. This can’t be undone."
            confirmLabel="Delete account"
            destructive
            onConfirm={() => remove.mutateAsync(user.id)}
          />
        </div>
      )}
    </li>
  )
}

export function PeopleTab() {
  const me = useUser()
  const users = useAdminUsers()
  const [reset, setReset] = useState<{ name: string; url: string } | null>(null)
  return (
    <>
      <Section id="people" title="Everyone on this server" flush>
        <QueryState query={users}>
          {(list) => (
            <ul>
              {list.map((user) => (
                <UserRow key={user.id} user={user} isMe={user.id === me?.id} onReset={(u, url) => setReset({ name: u.name, url })} />
              ))}
            </ul>
          )}
        </QueryState>
      </Section>
      <Dialog open={!!reset} onOpenChange={(open) => !open && setReset(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reset link for {reset?.name}</DialogTitle>
            <DialogDescription>Send this to them. It works once.</DialogDescription>
          </DialogHeader>
          {reset && <CopyField label="Reset link" value={reset.url} multiline />}
          <DialogFooter>
            <Button onClick={() => setReset(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
