import { ListChecks, SearchX } from 'lucide-react'
import { useId, useState } from 'react'
import type { JobStatus } from '@shared/types'
import { PageHeader } from '@/components/page'
import { useAppActions } from '@/components/shell/app-actions'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { SlotTabs } from '@/extensions/slot-tabs'
import { usePrintablePrinters, usePrinterRights } from '@/hooks/access'
import { useExtensionActive } from '@/hooks/extensions'
import { useJobs } from '@/hooks/jobs'
import { usePrinters } from '@/hooks/printers'
import { useWs } from '@/hooks/workspace'
import type { JobFilters } from '@/lib/api/types'
import { JOB_STATUS_LABELS } from '@/lib/words'
import { ChoiceSelect } from '../print/choice-select'
import { JobCards, JobTable } from './job-list'

const ALL = 'all'

function Filters({ ws, filters, onChange }: { ws: string; filters: JobFilters; onChange: (next: JobFilters) => void }) {
  const id = useId()
  const printers = (usePrinters(ws).data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
  // `held` only exists with Enterprise controls.
  const held = useExtensionActive(ws, 'enterprise')
  const statuses = (Object.entries(JOB_STATUS_LABELS) as [JobStatus, { label: string }][]).filter(([status]) => held || status !== 'held')
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
      <Field>
        <FieldLabel htmlFor={`${id}-printer`}>Printer</FieldLabel>
        <ChoiceSelect
          id={`${id}-printer`}
          value={filters.printerId ?? ALL}
          onChange={(v) => onChange({ ...filters, printerId: v === ALL ? undefined : v })}
          options={[{ value: ALL, label: 'All printers' }, ...printers.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
        <ChoiceSelect
          id={`${id}-status`}
          value={filters.status ?? ALL}
          onChange={(v) => onChange({ ...filters, status: v === ALL ? undefined : v })}
          options={[{ value: ALL, label: 'Any status' }, ...statuses.map(([value, words]) => ({ value, label: words.label }))]}
        />
      </Field>
    </div>
  )
}

export default function Jobs() {
  const ws = useWs()
  const { openPrint } = useAppActions()
  const { managed } = usePrinterRights(ws)
  const printable = usePrintablePrinters(ws).data ?? []
  const canPrint = !managed || printable.length > 0
  const [filters, setFilters] = useState<JobFilters>({})
  const jobs = useJobs(ws, filters)
  const filtered = !!(filters.printerId || filters.status)
  const list = jobs.data ?? []

  return (
    <>
      <PageHeader
        title="Print jobs"
        description="Everything sent to your printers, newest first. This list updates by itself."
        actions={canPrint && <Button onClick={() => openPrint()}>Print something</Button>}
      />
      <SlotTabs name="jobsTab" props={{ ws }} base={`w/${ws}/jobs`} main={{ id: 'all', label: 'All jobs' }}>
        <Filters ws={ws} filters={filters} onChange={setFilters} />
        {jobs.error && !jobs.data ? (
          <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
        ) : jobs.isPending ? (
          <SkeletonRows rows={4} />
        ) : list.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title="No print jobs match"
              description="Try a different printer or status."
              action={
                <Button variant="outline" onClick={() => setFilters({})}>
                  Show all print jobs
                </Button>
              }
            />
          ) : (
            <EmptyState icon={ListChecks} title="Nothing printed yet" description="When you print something, it shows up here so you can follow it." />
          )
        ) : (
          <div className="flex flex-col gap-6">
            <JobTable ws={ws} jobs={list} />
            <JobCards ws={ws} jobs={list} />
            {jobs.hasNextPage && (
              <Button variant="outline" className="self-center" onClick={() => jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>
                {jobs.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                Show more
              </Button>
            )}
          </div>
        )}
      </SlotTabs>
    </>
  )
}
