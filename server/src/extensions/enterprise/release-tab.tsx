import { Unlock } from 'lucide-react'
import { useId, useState } from 'react'
import type { Job } from '@shared/types'
import { EmptyState, QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useCanManage } from '@/hooks/workspace'
import { plural } from '@/lib/format'
import type { SlotProps } from '../registry'
import { HeldCard, useSenderName } from './held-card'
import { useReady, useRelease, useReleaseAll } from './hooks'

function Ready({ ws, job, sender }: { ws: string; job: Job; sender?: string }) {
  const release = useRelease(ws)
  return (
    <HeldCard job={job} sender={sender} large>
      <Button size="lg" onClick={() => release.mutate(job.id)} disabled={release.isPending} aria-label={`Release ${job.title}`}>
        {release.isPending ? <Spinner data-icon="inline-start" /> : <Unlock data-icon="inline-start" />}
        Release
      </Button>
    </HeldCard>
  )
}

/** Print jobs > Ready to release: built for a phone held up at the printer. */
export default function ReleaseTab({ ws }: SlotProps['jobsTab']) {
  const id = useId()
  const canManage = useCanManage()
  const [everyone, setEveryone] = useState(false)
  const ready = useReady(ws, everyone)
  const releaseAll = useReleaseAll(ws)
  const sender = useSenderName(ws)
  const mine = (ready.data ?? []).length
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[0.9375rem] text-muted-foreground">
          {everyone ? 'Everyone’s jobs waiting at a printer.' : 'Your jobs wait here until you release them. Open this page on your phone at the printer.'}
        </p>
        {canManage && (
          <label htmlFor={`${id}-everyone`} className="flex shrink-0 items-center gap-3 text-[0.9375rem] font-medium">
            <Switch id={`${id}-everyone`} checked={everyone} onCheckedChange={setEveryone} />
            Everyone’s jobs
          </label>
        )}
      </div>
      {!everyone && mine > 1 && (
        <Button size="lg" className="w-full sm:w-fit" onClick={() => releaseAll.mutate(undefined)} disabled={releaseAll.isPending}>
          {releaseAll.isPending ? <Spinner data-icon="inline-start" /> : <Unlock data-icon="inline-start" />}
          Release all {plural(mine, 'job')}
        </Button>
      )}
      <QueryState query={ready}>
        {(jobs) =>
          jobs.length === 0 ? (
            <EmptyState icon={Unlock} title="Nothing to release" description="Jobs you send to a printer that holds them show up here." />
          ) : (
            <ul className="flex flex-col gap-3">
              {jobs.map((job) => (
                <Ready key={job.id} ws={ws} job={job} sender={everyone ? sender(job) : undefined} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </div>
  )
}
