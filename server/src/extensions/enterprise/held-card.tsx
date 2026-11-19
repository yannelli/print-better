import type { ReactNode } from 'react'
import type { Job } from '@shared/types'
import { useMembers } from '@/hooks/members'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { untilWords } from './words'

/** Who sent a job, in words. */
export function useSenderName(ws: string): (job: Job) => string {
  const members = useMembers(ws).data
  return (job) => {
    if (job.userId) return members?.find((m) => m.userId === job.userId)?.name ?? 'A member'
    if (job.source === 'device') return job.sourceClientName ?? 'A computer'
    return 'Someone by email'
  }
}

/** One held job: what, who, where, why, and when it runs out, with its buttons. */
export function HeldCard({ job, sender, children, large }: { job: Job; sender?: string; children: ReactNode; large?: boolean }) {
  const until = job.held?.until ?? job.updatedAt
  const ending = job.held?.kind === 'approval' ? 'Canceled if nobody answers' : 'Canceled if not released'
  return (
    <li className={cn('flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6', large && 'gap-5')}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn('font-medium break-words', large ? 'text-lg' : 'text-[0.9375rem]')}>{job.title || 'Untitled'}</span>
        <span className="text-sm text-muted-foreground">
          {sender ? `${sender} to ` : 'To '}
          {job.printerName ?? 'a removed printer'}, {timeAgo(job.createdAt)}
        </span>
        {(job.held?.reasons ?? []).length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {job.held?.reasons?.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <span className="text-sm text-muted-foreground">
          {ending} {untilWords(until)}.
        </span>
      </div>
      <div className={cn('flex flex-wrap items-center gap-2', large && '[&>*]:flex-1 sm:[&>*]:flex-none')}>{children}</div>
    </li>
  )
}
