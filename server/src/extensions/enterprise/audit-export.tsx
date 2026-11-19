import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { Section } from '@/components/page'
import { buttonVariants } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { auditCsvUrl } from './api'
import { presetRange, rangeProblem } from './report-range'

/** The workspace audit log as CSV, for a range of dates. */
export function AuditExport({ ws }: { ws: string }) {
  const id = useId()
  const [range, setRange] = useState(() => presetRange('month'))
  const problem = rangeProblem(range)
  return (
    <Section id="audit-export" title="Audit log" description="This workspace’s activity log as a CSV file, the same entries as Workspace settings > Activity. Times are in UTC.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <Field className="sm:w-44">
          <FieldLabel htmlFor={`${id}-from`}>From</FieldLabel>
          <Input id={`${id}-from`} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field className="sm:w-44">
          <FieldLabel htmlFor={`${id}-to`}>To</FieldLabel>
          <Input id={`${id}-to`} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
        <a
          href={problem ? undefined : auditCsvUrl(ws, range.from, range.to)}
          download
          aria-disabled={!!problem}
          className={cn(buttonVariants({ variant: 'outline' }), problem && 'pointer-events-none opacity-50')}
        >
          <Download data-icon="inline-start" />
          Export CSV
        </a>
      </div>
      {problem && <FieldError className="mt-3">{problem}</FieldError>}
    </Section>
  )
}
