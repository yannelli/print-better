import { Check, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import type { Job } from '@shared/types'
import { EmptyState, QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { SlotProps } from '../registry'
import { DenyDialog } from './deny-dialog'
import { HeldCard, useSenderName } from './held-card'
import { useApprovals, useApprove } from './hooks'

function Waiting({ ws, job, sender }: { ws: string; job: Job; sender: string }) {
  const approve = useApprove(ws)
  const [denying, setDenying] = useState(false)
  return (
    <HeldCard job={job} sender={sender}>
      <Button onClick={() => approve.mutate({ id: job.id })} disabled={approve.isPending}>
        {approve.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
        Approve
      </Button>
      <Button variant="outline" onClick={() => setDenying(true)}>
        <X data-icon="inline-start" />
        Deny
      </Button>
      {denying && <DenyDialog ws={ws} job={job} open={denying} onOpenChange={setDenying} />}
    </HeldCard>
  )
}

/** Print jobs > Approvals: every job the caller may approve, oldest first. */
export default function ApprovalsTab({ ws }: SlotProps['jobsTab']) {
  const approvals = useApprovals(ws)
  const sender = useSenderName(ws)
  return (
    <QueryState query={approvals}>
      {(jobs) =>
        jobs.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing waiting for you" description="Jobs that need your approval show up here." />
        ) : (
          <ul className="flex max-w-3xl flex-col gap-3">
            {jobs.map((job) => (
              <Waiting key={job.id} ws={ws} job={job} sender={sender(job)} />
            ))}
          </ul>
        )
      }
    </QueryState>
  )
}
