import { type FormEvent, useId, useState } from 'react'
import type { ReportDimension, ReportScheduleInput } from '@shared/enterprise'
import type { Cycle } from '@shared/usage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ChoiceSelect } from '@/routes/settings/fields'
import { CycleField } from '../usage/cycle-field'
import { enterpriseApi } from './api'
import { useEnterpriseMutation } from './hooks'
import { MemberPicker } from './member-picker'
import { DIMENSIONS } from './words'

const KINDS = ['week', 'month'] as const

/** A weekly or monthly usage report, emailed with the CSV attached. */
export function ScheduleDialog({ ws, onOpenChange }: { ws: string; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const [name, setName] = useState('Monthly printing')
  const [by, setBy] = useState<ReportDimension>('cost-center')
  const [cycle, setCycle] = useState<ReportScheduleInput['cycle']>({ kind: 'month', startDay: 1 })
  const [recipients, setRecipients] = useState<string[]>([])
  const create = useEnterpriseMutation(ws, (input: ReportScheduleInput) => enterpriseApi.createSchedule(ws, input), 'Report scheduled')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate({ name: name.trim(), by, cycle, recipients }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Schedule a report</DialogTitle>
            <DialogDescription>Sent at 8:00 on the first day of each week or month, covering the one that just ended, with every row in a CSV file.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            <FieldDescription>The email subject starts with it.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-by`}>Usage by</FieldLabel>
            <ChoiceSelect id={`${id}-by`} value={by} onChange={setBy} options={DIMENSIONS} className="sm:w-full" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-cycle`}>How often</FieldLabel>
            <CycleField id={`${id}-cycle`} value={cycle} onChange={(next: Cycle) => setCycle(next as typeof cycle)} kinds={KINDS} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-to`}>Send to</FieldLabel>
            <MemberPicker id={`${id}-to`} ws={ws} value={recipients} onChange={setRecipients} placeholder="Add people" />
            <FieldDescription>Only people with an email address get it.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || recipients.length === 0 || create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
