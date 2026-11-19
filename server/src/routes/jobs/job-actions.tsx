import { Download, RotateCw, Trash2, X } from 'lucide-react'
import { type Job, TERMINAL_JOB_STATUSES } from '@shared/types'
import { Confirm } from '@/components/confirm'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useUser } from '@/hooks/auth'
import { useDeleteJob, useJobAction } from '@/hooks/jobs'
import { useCanManage } from '@/hooks/workspace'
import { jobFileUrl } from '@/lib/api/jobs'

const isTerminal = (job: Job) => TERMINAL_JOB_STATUSES.includes(job.status)

export function JobActions({ ws, job }: { ws: string; job: Job }) {
  const user = useUser()
  const canManage = useCanManage()
  const cancel = useJobAction(ws, 'cancel')
  const retry = useJobAction(ws, 'retry')
  const remove = useDeleteJob(ws)
  const mine = canManage || (!!user && job.userId === user.id)
  const name = job.title || job.fileName || 'this print job'
  const canRetry = mine && job.hasFile && (job.status === 'failed' || job.status === 'canceled')

  return (
    <div className="flex flex-wrap items-center gap-2">
      {mine && !isTerminal(job) && (
        <Button variant="outline" size="sm" onClick={() => cancel.mutate(job.id)} disabled={cancel.isPending} aria-label={`Cancel ${name}`}>
          {cancel.isPending ? <Spinner data-icon="inline-start" /> : <X data-icon="inline-start" />}
          Cancel
        </Button>
      )}
      {canRetry && (
        <Button variant="outline" size="sm" onClick={() => retry.mutate(job.id)} disabled={retry.isPending} aria-label={`Try ${name} again`}>
          {retry.isPending ? <Spinner data-icon="inline-start" /> : <RotateCw data-icon="inline-start" />}
          Try again
        </Button>
      )}
      {job.hasFile && (
        <a
          href={jobFileUrl(ws, job.id)}
          download={job.fileName ?? undefined}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          aria-label={`Download ${name}`}
          title="Download"
        >
          <Download />
        </a>
      )}
      {canManage && isTerminal(job) && (
        <Confirm
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name} from the list`} title="Remove from the list">
              <Trash2 />
            </Button>
          }
          title="Remove this print job?"
          description="It disappears from the list and its file is deleted."
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutateAsync(job.id)}
        />
      )}
    </div>
  )
}
