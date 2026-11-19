import { FileText } from 'lucide-react'
import { Link } from 'wouter'
import { wsHref } from '@/components/shell/app-actions'
import { Section } from '@/components/page'
import { SkeletonRows } from '@/components/states'
import { StatusPill } from '@/components/status'
import { useJobs } from '@/hooks/jobs'
import { dateTime, timeAgo } from '@/lib/format'
import { jobStatus } from '@/lib/words'

const SHOWN = 5

export function RecentJobs({ ws }: { ws: string }) {
  const jobs = useJobs(ws)
  const list = jobs.data?.slice(0, SHOWN) ?? []
  if (jobs.isPending) return <SkeletonRows rows={2} />
  if (list.length === 0) return null
  return (
    <Section
      title="Recent print jobs"
      flush
      actions={
        <Link href={wsHref(ws, '/jobs')} className="rounded-full px-3 py-2 text-[0.9375rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          See all print jobs
        </Link>
      }
    >
      <ul>
        {list.map((job) => {
          const status = jobStatus(job)
          return (
            <li key={job.id} className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <FileText className="size-5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{job.title || job.fileName || 'Untitled'}</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {job.printerName ?? 'Removed printer'}, <time title={dateTime(job.createdAt)}>{timeAgo(job.createdAt)}</time>
                  </span>
                </div>
              </div>
              <StatusPill status={status} className="sm:shrink-0" />
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
