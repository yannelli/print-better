import type { Job } from '@shared/types'
import { StatusPill } from '@/components/status'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Slot } from '@/extensions/slot'
import { bytes, dateTime, plural, timeAgo } from '@/lib/format'
import { jobOrigin, jobStatus } from '@/lib/words'
import { JobActions } from './job-actions'

function title(job: Job) {
  return job.title || job.fileName || 'Untitled'
}

function sizeLine(job: Job) {
  const parts = [bytes(job.size)]
  if (job.pages != null) parts.push(plural(job.pages, 'page'))
  return parts.join(', ')
}

function Status({ job }: { job: Job }) {
  const status = jobStatus(job)
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusPill status={status} />
      {status.detail && <span className="max-w-xs text-sm whitespace-normal text-muted-foreground">{status.detail}</span>}
      {job.attempts > 1 && <span className="text-sm text-muted-foreground">Try {job.attempts}</span>}
    </div>
  )
}

function When({ job }: { job: Job }) {
  return (
    <div className="flex flex-col">
      <time dateTime={new Date(job.createdAt).toISOString()} title={dateTime(job.createdAt)}>
        {timeAgo(job.createdAt)}
      </time>
      <span className="text-sm text-muted-foreground">{jobOrigin(job)}</span>
    </div>
  )
}

export function JobTable({ ws, jobs }: { ws: string; jobs: Job[] }) {
  return (
    <div className="hidden overflow-hidden rounded-3xl border bg-card md:block">
      <Table className="text-[0.9375rem]">
        <TableHeader className="bg-surface">
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-6">Document</TableHead>
            <TableHead>Printer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead className="pr-6">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell className="max-w-72 py-4 pl-6">
                <div className="flex flex-col">
                  <span className="truncate font-medium">{title(job)}</span>
                  <span className="text-sm text-muted-foreground">{sizeLine(job)}</span>
                  <Slot name="jobMeta" props={{ ws, job }} />
                </div>
              </TableCell>
              <TableCell className="max-w-48 truncate">{job.printerName ?? 'Removed printer'}</TableCell>
              <TableCell>
                <Status job={job} />
              </TableCell>
              <TableCell>
                <When job={job} />
              </TableCell>
              <TableCell className="pr-6">
                <div className="flex justify-end">
                  <JobActions ws={ws} job={job} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function JobCards({ ws, jobs }: { ws: string; jobs: Job[] }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {jobs.map((job) => (
        <li key={job.id} className="flex flex-col gap-3 rounded-3xl border bg-card p-5">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium break-words">{title(job)}</span>
            <span className="text-sm text-muted-foreground">
              {job.printerName ?? 'Removed printer'}, {sizeLine(job)}
            </span>
            <Slot name="jobMeta" props={{ ws, job }} />
          </div>
          <Status job={job} />
          <When job={job} />
          <JobActions ws={ws} job={job} />
        </li>
      ))}
    </ul>
  )
}
