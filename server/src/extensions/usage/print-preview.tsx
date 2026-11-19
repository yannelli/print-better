import { ChevronDown, CircleAlert } from 'lucide-react'
import type { JobPreview, Prices } from '@shared/usage'
import { formatAmount, formatMicros } from '@shared/usage-text'
import { usePrinters } from '@/hooks/printers'
import { fileContentType } from '@/routes/print/use-print-submit'
import type { SlotProps } from '../registry'
import { useJobPreview, usePrices } from './hooks'
import { useDocumentPages, useSettled } from './use-document-pages'
import { meterLine, tightest } from './words'

const HOLDS = { approval: 'It waits for approval before it prints.', release: 'It waits until you release it at the printer.' }

function jobAmount(preview: JobPreview, unit: JobPreview['meters'][number]['unit'], currency: string): string {
  const { usage } = preview
  const value = unit === 'pages' ? usage.pages : unit === 'sheets' ? usage.sheets : unit === 'jobs' ? 1 : usage.costMicros
  return formatAmount(unit, value, currency)
}

/** The one line people always see: a refusal, or what the tightest limit leaves them. */
function Outcome({ preview, prices }: { preview: JobPreview; prices: Prices }) {
  if (preview.block) {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive" role="status">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>This job will be refused: {preview.block}</span>
      </p>
    )
  }
  const meter = tightest(preview.meters)
  if (!meter) return null
  const line = `${meterLine(meter, prices.currency, prices.timeZone)}. This job uses ${jobAmount(preview, meter.unit, prices.currency)}.`
  return (
    <p className={meter.over ? 'text-sm text-on-warn-container' : 'text-sm text-muted-foreground'} role="status">
      {meter.over ? `This job goes over ${meter.name}: ${line}` : line}
    </p>
  )
}

function Details({ preview, prices, printerName }: { preview: JobPreview; prices: Prices; printerName: string | null }) {
  const { pages, sheets, costMicros, documentPages } = preview.usage
  const cost = costMicros > 0 ? `, about ${formatMicros(costMicros, prices.currency)}` : ''
  return (
    <details className="group text-sm">
      <summary className="press inline-flex cursor-pointer list-none items-center gap-1 rounded-full font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        What happens to this job
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        {printerName && <li>It goes to {printerName} instead.</li>}
        {preview.notes.map((note, i) => (
          <li key={i}>
            {note.name}: {note.message}
          </li>
        ))}
        {preview.hold && <li>{HOLDS[preview.hold]}</li>}
        <li>
          {formatAmount('pages', pages, prices.currency)} on {formatAmount('sheets', sheets, prices.currency)}
          {cost}.{documentPages === null && " The pages couldn't be counted here, so each copy counts as 1 page until it prints."}
        </li>
        {preview.meters.map((m) => (
          <li key={`${m.kind}-${m.id}`}>
            {m.name}: {meterLine(m, prices.currency, prices.timeZone)}.
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Print dialog: what will happen to the job and what it leaves, from POST /jobs/preview. */
export default function PrintPreview({ ws, draft, extra }: SlotProps['printForm']) {
  const printers = usePrinters(ws).data
  const printer = printers?.find((p) => p.id === draft.printerId)
  const prices = usePrices(ws).data
  const { document, options } = draft
  const contentType = document ? fileContentType(document) : null
  const media = options.media ?? printer?.defaults.media ?? printer?.capabilities.mediaDefault ?? null
  const pages = useDocumentPages(document, contentType, { media, landscape: (options.orientation ?? printer?.defaults.orientation) === 'landscape' })
  const request = useSettled(
    document && contentType && !pages.isPending ? { ...extra, printerId: draft.printerId, options, contentType, size: document.size, documentPages: pages.data ?? null } : null,
    300,
  )
  const preview = useJobPreview(ws, request).data
  if (!request || !preview || !prices) return null
  const moved = preview.printerId !== draft.printerId ? (printers?.find((p) => p.id === preview.printerId)?.name ?? 'another printer') : null
  return (
    <div className="flex flex-col gap-2">
      <Outcome preview={preview} prices={prices} />
      <Details preview={preview} prices={prices} printerName={moved} />
    </div>
  )
}
