import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReportDimension } from '@shared/enterprise'
import { QueryState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ChoiceSelect } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { reportCsvUrl } from './api'
import { AuditExport } from './audit-export'
import { useReport } from './hooks'
import { type DayRange, presetRange, RANGE_PRESETS, type RangePreset, rangeProblem } from './report-range'
import { ReportView } from './report-view'
import { SchedulesSection } from './schedules-section'
import { DIMENSIONS } from './words'

/** Usage > Reports (admins): usage by any dimension and dates, scheduled emails, and the audit export. */
export default function ReportsTab({ ws }: SlotProps['usageTab']) {
  const id = useId()
  const [by, setBy] = useState<ReportDimension>('member')
  const [preset, setPreset] = useState<RangePreset>('month')
  const [range, setRange] = useState<DayRange>(() => presetRange('month'))
  const problem = rangeProblem(range)
  const query = { by, ...range }
  const report = useReport(ws, query, !problem)
  const choose = (next: RangePreset) => {
    setPreset(next)
    if (next !== 'custom') setRange(presetRange(next))
  }
  const edit = (patch: Partial<DayRange>) => {
    setPreset('custom')
    setRange({ ...range, ...patch })
  }
  return (
    <div className="flex max-w-5xl flex-col gap-12">
      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-6">
        <h2 id={`${id}-title`} className="sr-only">
          Usage report
        </h2>
        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
          <Field className="lg:w-48">
            <FieldLabel htmlFor={`${id}-by`}>Usage by</FieldLabel>
            <ChoiceSelect id={`${id}-by`} value={by} onChange={setBy} options={DIMENSIONS} className="sm:w-full" />
          </Field>
          <Field className="lg:w-48">
            <FieldLabel htmlFor={`${id}-range`}>Dates</FieldLabel>
            <ChoiceSelect id={`${id}-range`} value={preset} onChange={choose} options={RANGE_PRESETS} className="sm:w-full" />
          </Field>
          <div className="grid grid-cols-2 gap-4 lg:flex">
            <Field className="lg:w-44">
              <FieldLabel htmlFor={`${id}-from`}>From</FieldLabel>
              <Input id={`${id}-from`} type="date" value={range.from} onChange={(e) => edit({ from: e.target.value })} />
            </Field>
            <Field className="lg:w-44">
              <FieldLabel htmlFor={`${id}-to`}>To</FieldLabel>
              <Input id={`${id}-to`} type="date" value={range.to} onChange={(e) => edit({ to: e.target.value })} />
            </Field>
          </div>
          <a
            href={problem ? undefined : reportCsvUrl(ws, query)}
            download
            aria-disabled={!!problem}
            className={cn(buttonVariants({ variant: 'outline' }), 'lg:ml-auto', problem && 'pointer-events-none opacity-50')}
          >
            <Download data-icon="inline-start" />
            Export CSV
          </a>
        </div>
        {problem ? <FieldError>{problem}</FieldError> : <QueryState query={report}>{(data) => <ReportView report={data} />}</QueryState>}
      </section>
      <SchedulesSection ws={ws} />
      <AuditExport ws={ws} />
    </div>
  )
}
