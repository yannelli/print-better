import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useDeleteInvite, useInvites } from '@/hooks/members'
import { date } from '@/lib/format'
import { ROLE_NAMES } from '@/lib/words'

export function InviteList({ ws }: { ws: string }) {
  const invites = useInvites(ws)
  const cancel = useDeleteInvite(ws)
  return (
    <QueryState query={invites} loading={false}>
      {(list) =>
        list.length > 0 && (
          <Section id="invites" title="Waiting to join" description="Invites that haven’t been used yet." flush>
            <ul>
              {list.map((invite) => (
                <li
                  key={invite.id}
                  className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[0.9375rem] font-medium">{invite.email ?? 'Anyone with the link'}</span>
                    <span className="text-sm text-muted-foreground">
                      Joins as {ROLE_NAMES[invite.role].toLowerCase()}, link expires {date(invite.expiresAt)}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => cancel.mutate(invite.id)}
                    disabled={cancel.isPending && cancel.variables === invite.id}
                    className="self-start sm:self-auto"
                  >
                    Cancel invite
                  </Button>
                </li>
              ))}
            </ul>
          </Section>
        )
      }
    </QueryState>
  )
}
