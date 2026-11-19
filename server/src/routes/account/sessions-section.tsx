import { Monitor } from 'lucide-react'
import { Confirm } from '@/components/confirm'
import { Mono, Section } from '@/components/page'
import { StatusPill } from '@/components/status'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useEndSession, useSessions } from '@/hooks/account'
import { dateTime, timeAgo } from '@/lib/format'
import { describeAgent } from './user-agent'

export function SessionsSection() {
  const sessions = useSessions()
  const end = useEndSession()
  const others = sessions.data?.filter((s) => !s.current) ?? []
  return (
    <Section
      id="sessions"
      title="Where you’re signed in"
      description="If you see a device you don’t recognise, sign it out and change your password."
      actions={
        others.length > 1 && (
          <Confirm
            trigger={<Button variant="outline">Sign out everywhere else</Button>}
            title="Sign out of every other device?"
            description="This device stays signed in."
            confirmLabel="Sign out others"
            onConfirm={() => Promise.all(others.map((s) => end.mutateAsync(s.id)))}
          />
        )
      }
      flush
    >
      <QueryState query={sessions}>
        {(list) => (
          <ul>
            {[...list]
              .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
              .map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
                      <Monitor className="size-5" />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium">
                        {describeAgent(s.userAgent)}
                        {s.current && <StatusPill status={{ label: 'This device', tone: 'ok' }} />}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {s.current ? 'Active now' : `Last active ${timeAgo(s.lastSeenAt)}`}, signed in {dateTime(s.createdAt)}
                        {s.ip && (
                          <>
                            , from <Mono>{s.ip}</Mono>
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => end.mutate(s.id)}
                      disabled={end.isPending && end.variables === s.id}
                      className="self-start sm:self-auto"
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
