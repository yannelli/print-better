import { Check, Unlock, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePrinterRights } from '@/hooks/access'
import { useUser } from '@/hooks/auth'
import { mayApprove } from '@/lib/access'
import type { SlotProps } from '../registry'
import { DenyDialog } from './deny-dialog'
import { useApprove, useRelease } from './hooks'
import { mayRelease } from './words'

/** Approve and Deny, or Release, beside a held job in Print jobs. */
export default function HoldActions({ ws, job }: SlotProps['jobActions']) {
  const userId = useUser()?.id
  const rights = usePrinterRights(ws)
  const approve = useApprove(ws)
  const release = useRelease(ws)
  const [denying, setDenying] = useState(false)
  if (job.status !== 'held' || !job.held) return null

  if (job.held.kind === 'release') {
    if (!mayRelease(job, userId, rights)) return null
    return (
      <Button size="sm" onClick={() => release.mutate(job.id)} disabled={release.isPending} aria-label={`Release ${job.title}`}>
        {release.isPending ? <Spinner data-icon="inline-start" /> : <Unlock data-icon="inline-start" />}
        Release
      </Button>
    )
  }
  if (!mayApprove(job, userId, rights)) return null
  return (
    <>
      <Button size="sm" onClick={() => approve.mutate({ id: job.id })} disabled={approve.isPending} aria-label={`Approve ${job.title}`}>
        {approve.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
        Approve
      </Button>
      <Button size="sm" variant="outline" onClick={() => setDenying(true)} aria-label={`Deny ${job.title}`}>
        <X data-icon="inline-start" />
        Deny
      </Button>
      {denying && <DenyDialog ws={ws} job={job} open={denying} onOpenChange={setDenying} />}
    </>
  )
}
