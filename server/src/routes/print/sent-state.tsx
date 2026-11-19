import { CircleCheck, CircleX, Send, TriangleAlert } from 'lucide-react'
import type { Job } from '@shared/types'
import { StatusPill, toneContainer } from '@/components/status'
import { Button } from '@/components/ui/button'
import { useJob } from '@/hooks/jobs'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { jobStatus, printedWithProblem } from '@/lib/words'

export function SentState({
  ws,
  job: created,
  printerName,
  onAnother,
  onDone,
}: {
  ws: string
  job: Job
  printerName: string
  onAnother: () => void
  onDone: () => void
}) {
  const job = useJob(ws, created.id).data ?? created
  const words = jobStatus(job)
  const warned = printedWithProblem(job)
  const Icon = warned ? TriangleAlert : job.status === 'completed' ? CircleCheck : job.status === 'failed' ? CircleX : Send
  const tone = job.status === 'failed' ? 'bad' : warned ? 'warn' : 'ok'
  return (
    <div className="flex flex-col items-center gap-6 py-6 text-center">
      <span
        className={cn('flex size-20 items-center justify-center rounded-[2rem] animate-in zoom-in-50 duration-500 ease-spring', toneContainer(tone))}
      >
        <Icon className="size-9" />
      </span>
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Sent to {printerName}</h2>
        <p className="max-w-sm text-base text-muted-foreground">{job.title}</p>
      </div>
      <div aria-live="polite" className="flex flex-col items-center gap-2">
        <StatusPill status={words} size="lg" />
        {words.detail && <p className="max-w-sm text-sm text-muted-foreground">{words.detail}</p>}
        {job.status === 'completed' && job.pages != null && (
          <p className="text-sm text-muted-foreground">{plural(job.pages, 'page')} printed</p>
        )}
      </div>
      <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
        <Button variant="outline" onClick={onAnother}>
          Print another
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}
