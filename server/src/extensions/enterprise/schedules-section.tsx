import { Plus } from 'lucide-react'
import { useState } from 'react'
import type { ReportSchedule } from '@shared/enterprise'
import { Confirm } from '@/components/confirm'
import { Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useMembers } from '@/hooks/members'
import { dateTime } from '@/lib/format'
import { cycleLabel } from '../usage/cycles'
import { enterpriseApi } from './api'
import { useEnterpriseMutation, useSchedules } from './hooks'
import { ScheduleDialog } from './schedule-dialog'
import { DIMENSIONS } from './words'

function ScheduleRow({ ws, schedule, names }: { ws: string; schedule: ReportSchedule; names: (ids: string[]) => string }) {
  const remove = useEnterpriseMutation(ws, () => enterpriseApi.deleteSchedule(ws, schedule.id), 'Schedule deleted')
  const by = DIMENSIONS.find((d) => d.value === schedule.by)?.label.toLowerCase()
  return (
    <li className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[0.9375rem] font-medium">{schedule.name}</span>
        <span className="text-sm text-muted-foreground">
          Usage by {by}, {cycleLabel(schedule.cycle).toLowerCase()}, to {names(schedule.recipients)}
        </span>
        <span className="text-sm text-muted-foreground">Next: {dateTime(schedule.nextRunAt)}</span>
      </div>
      <Confirm
        trigger={
          <Button variant="ghost" size="sm" className="w-fit">
            Delete
          </Button>
        }
        title={`Stop sending ${schedule.name}?`}
        description="Reports already sent stay in people’s inboxes."
        confirmLabel="Delete"
        destructive
        onConfirm={() => remove.mutateAsync(undefined)}
      />
    </li>
  )
}

/** Weekly and monthly reports by email. */
export function SchedulesSection({ ws }: { ws: string }) {
  const schedules = useSchedules(ws)
  const members = useMembers(ws).data
  const [adding, setAdding] = useState(false)
  const names = (ids: string[]) => ids.map((id) => members?.find((m) => m.userId === id)?.name ?? 'a former member').join(', ')
  return (
    <Section
      id="report-schedules"
      title="Scheduled reports"
      description="Emailed when outbound email is set up, with a summary and every row as a CSV file."
      actions={
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" />
          Schedule
        </Button>
      }
      flush
    >
      <QueryState query={schedules}>
        {(list) =>
          list.length === 0 ? (
            <p className="px-5 py-6 text-muted-foreground sm:px-6">No reports are scheduled.</p>
          ) : (
            <ul>
              {list.map((schedule) => (
                <ScheduleRow key={schedule.id} ws={ws} schedule={schedule} names={names} />
              ))}
            </ul>
          )
        }
      </QueryState>
      {adding && <ScheduleDialog ws={ws} onOpenChange={setAdding} />}
    </Section>
  )
}
