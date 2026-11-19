import { useMemo } from 'react'
import type { Prices } from '@shared/usage'
import { Row, Section } from '@/components/page'
import { QueryState } from '@/components/states'
import { FieldError } from '@/components/ui/field'
import { useCanManage } from '@/hooks/workspace'
import { useDraft } from '@/routes/settings/draft'
import { SaveBar } from '@/routes/settings/fields'
import type { SlotProps } from '../registry'
import { usePrices, useSetPrices } from './hooks'
import { MoneyInput } from './money-input'
import { PrinterPrices } from './printer-prices'
import { CURRENCIES, SearchSelect, timeZoneChoices } from './search-select'
import { PRICE_FIELDS, parseMoney, parsePrices, priceText } from './words'

const plain = 'text-[0.9375rem] text-muted-foreground'

function Region({ ws, prices, canEdit }: { ws: string; prices: Prices; canEdit: boolean }) {
  const set = useSetPrices(ws)
  const zones = useMemo(() => timeZoneChoices(prices.timeZone), [prices.timeZone])
  return (
    <Section id="usage-region" description="Costs show in this currency. Limits start over at midnight in this time zone, and times in rules use it too." flush>
      <Row label="Currency" htmlFor="usage-currency">
        {canEdit ? (
          <SearchSelect id="usage-currency" value={prices.currency} onChange={(currency) => set.mutate({ currency })} options={CURRENCIES} disabled={set.isPending} />
        ) : (
          <span className={plain}>{prices.currency}</span>
        )}
      </Row>
      <Row label="Time zone" htmlFor="usage-time-zone">
        {canEdit ? (
          <SearchSelect id="usage-time-zone" value={prices.timeZone} onChange={(timeZone) => set.mutate({ timeZone })} options={zones} disabled={set.isPending} />
        ) : (
          <span className={plain}>{prices.timeZone.replaceAll('_', ' ')}</span>
        )}
      </Row>
    </Section>
  )
}

function DefaultPrices({ ws, prices, canEdit }: { ws: string; prices: Prices; canEdit: boolean }) {
  const set = useSetPrices(ws)
  const { draft, dirty, set: edit, reset } = useDraft(priceText(prices.default))
  const parsed = parsePrices(draft)
  return (
    <Section
      id="usage-prices"
      title="Prices"
      description="What printing costs, for cost limits and the cost shown on each job. A printer can have its own prices below."
      flush
    >
      {PRICE_FIELDS.map((f) => (
        <Row key={f.key} label={f.label} htmlFor={`usage-${f.key}`} description={f.description}>
          <MoneyInput
            id={`usage-${f.key}`}
            value={draft[f.key]}
            onChange={(value) => edit({ [f.key]: value })}
            currency={prices.currency}
            disabled={!canEdit}
            invalid={parseMoney(draft[f.key]) === null}
          />
        </Row>
      ))}
      {canEdit && !parsed && <FieldError className="px-5 pt-3 sm:px-6">Enter amounts such as 0.05, with up to 6 decimals.</FieldError>}
      {canEdit && <SaveBar dirty={dirty} pending={set.isPending} onSave={() => parsed && set.mutate({ default: parsed })} onReset={reset} disabled={!parsed} />}
    </Section>
  )
}

/** Workspace settings > Prices: currency, time zone, and prices, shared by both usage extensions. */
export default function PricesTab({ ws }: SlotProps['settingsTab']) {
  const prices = usePrices(ws)
  const canEdit = useCanManage()
  return (
    <QueryState query={prices}>
      {(data) => (
        <>
          <Region ws={ws} prices={data} canEdit={canEdit} />
          <DefaultPrices ws={ws} prices={data} canEdit={canEdit} />
          <PrinterPrices ws={ws} prices={data} canEdit={canEdit} />
        </>
      )}
    </QueryState>
  )
}
