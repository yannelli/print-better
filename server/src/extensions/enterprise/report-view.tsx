import type { UsageReport, UsageTotals } from '@shared/enterprise'
import { formatMicros } from '@shared/usage-text'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DIMENSIONS } from './words'

const COLUMNS: { key: keyof UsageTotals; label: string }[] = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'pages', label: 'Pages' },
  { key: 'sheets', label: 'Sheets' },
  { key: 'colorPages', label: 'Color pages' },
  { key: 'costMicros', label: 'Cost' },
]

const dayLabel = (day: string) => new Date(`${day}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

const value = (totals: UsageTotals, key: keyof UsageTotals, currency: string) =>
  key === 'costMicros' ? formatMicros(totals[key], currency) : totals[key].toLocaleString()

function Totals({ report }: { report: UsageReport }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {COLUMNS.map((c) => (
        <div key={c.key} className="flex flex-col gap-1 rounded-3xl border bg-card px-5 py-4">
          <dt className="text-sm text-muted-foreground">{c.label}</dt>
          <dd className="tabular text-xl font-semibold tracking-tight">{value(report.totals, c.key, report.currency)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Pages per day as bars; each bar's title gives the day's numbers. */
function DayChart({ report }: { report: UsageReport }) {
  const most = Math.max(1, ...report.days.map((d) => d.pages))
  const label = `Pages per day from ${dayLabel(report.from)} to ${dayLabel(report.to)}, at most ${most} on one day`
  return (
    <figure className="flex flex-col gap-2 rounded-3xl border bg-card p-5 sm:p-6">
      <figcaption className="text-sm font-medium">Pages per day</figcaption>
      <div role="img" aria-label={label} className="flex h-32 items-end gap-px">
        {report.days.map((d) => (
          <div
            key={d.day}
            title={`${dayLabel(d.day)}: ${d.pages.toLocaleString()} pages, ${d.jobs.toLocaleString()} jobs`}
            className="min-w-0 flex-1 rounded-t-sm bg-primary/80"
            style={{ height: `${Math.max(d.pages > 0 ? 3 : 0, (d.pages / most) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{dayLabel(report.from)}</span>
        <span>{dayLabel(report.to)}</span>
      </div>
    </figure>
  )
}

/** Totals, the per-day chart, then one row per member, group, device, printer, cost center, or source. */
export function ReportView({ report }: { report: UsageReport }) {
  const heading = DIMENSIONS.find((d) => d.value === report.by)?.label ?? 'Name'
  return (
    <div className="flex flex-col gap-6">
      <Totals report={report} />
      {report.days.length > 1 && <DayChart report={report} />}
      {report.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed px-6 py-8 text-muted-foreground">Nothing was printed in these dates.</p>
      ) : (
        <div className="overflow-hidden rounded-3xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5 sm:px-6">{heading}</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right last:pr-5 sm:last:pr-6">
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.key ?? 'none'}>
                  <TableCell className="px-5 font-medium sm:px-6">{row.name}</TableCell>
                  {COLUMNS.map((c) => (
                    <TableCell key={c.key} className="tabular text-right last:pr-5 sm:last:pr-6">
                      {value(row, c.key, report.currency)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
            {report.by !== 'group' && (
              <TableFooter>
                <TableRow>
                  <TableCell className="px-5 font-medium sm:px-6">Total</TableCell>
                  {COLUMNS.map((c) => (
                    <TableCell key={c.key} className="tabular text-right last:pr-5 sm:last:pr-6">
                      {value(report.totals, c.key, report.currency)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
      {report.by === 'group' && report.rows.length > 0 && (
        <p className="px-1 text-sm text-muted-foreground">Someone in two groups counts in both, so the rows can add up to more than the totals.</p>
      )}
    </div>
  )
}
