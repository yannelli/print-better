import { Plus } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import type { Prices } from '@shared/usage'
import { Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { useAddedPrinters } from '@/hooks/printers'
import { ChoiceSelect } from '@/routes/settings/fields'
import { useSetPrices } from './hooks'
import { MoneyInput } from './money-input'
import { PRICE_FIELDS, parseMoney, parsePrices, priceSummary, priceText } from './words'

/** Sets one printer's own prices; `printerId` null lets the admin pick a printer that has none yet. */
function PrinterPriceDialog({
  ws,
  prices,
  printerId,
  choices,
  onClose,
}: {
  ws: string
  prices: Prices
  printerId: string | null
  choices: { value: string; label: string }[]
  onClose: () => void
}) {
  const id = useId()
  const set = useSetPrices(ws)
  const [printer, setPrinter] = useState(printerId ?? choices[0]?.value ?? '')
  const [text, setText] = useState(priceText(prices.printers[printer] ?? prices.default))
  const parsed = parsePrices(text)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (parsed && printer) set.mutate({ printers: { [printer]: parsed } }, { onSuccess: onClose })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{printerId ? 'Printer prices' : 'Set printer prices'}</DialogTitle>
            <DialogDescription>Jobs on this printer use these prices instead of the default.</DialogDescription>
          </DialogHeader>
          {!printerId && (
            <Field>
              <FieldLabel htmlFor={`${id}-printer`}>Printer</FieldLabel>
              <ChoiceSelect id={`${id}-printer`} value={printer} onChange={setPrinter} options={choices} className="sm:w-full" />
            </Field>
          )}
          {PRICE_FIELDS.map((f) => (
            <Field key={f.key}>
              <FieldLabel htmlFor={`${id}-${f.key}`}>{f.label}</FieldLabel>
              <MoneyInput
                id={`${id}-${f.key}`}
                value={text[f.key]}
                onChange={(value) => setText((t) => ({ ...t, [f.key]: value }))}
                currency={prices.currency}
                invalid={parseMoney(text[f.key]) === null}
              />
              <FieldDescription>{f.description}</FieldDescription>
            </Field>
          ))}
          {!parsed && <FieldError>Enter amounts such as 0.05, with up to 6 decimals.</FieldError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!parsed || !printer || set.isPending}>
              {set.isPending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Printers with their own prices; the others use the default. */
export function PrinterPrices({ ws, prices, canEdit }: { ws: string; prices: Prices; canEdit: boolean }) {
  const printers = useAddedPrinters(ws).data ?? []
  const set = useSetPrices(ws)
  const [editing, setEditing] = useState<{ printerId: string | null } | null>(null)
  const own = Object.entries(prices.printers)
  const nameOf = (id: string) => printers.find((p) => p.id === id)?.name ?? 'A removed printer'
  const choices = printers.filter((p) => !prices.printers[p.id]).map((p) => ({ value: p.id, label: p.name }))
  return (
    <Section
      id="printer-prices"
      title="Printer prices"
      description="For printers that cost more or less to run than the default."
      actions={
        canEdit &&
        choices.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setEditing({ printerId: null })}>
            <Plus data-icon="inline-start" />
            Set printer prices
          </Button>
        )
      }
      flush
    >
      {own.length === 0 ? (
        <p className="px-5 py-5 text-[0.9375rem] text-muted-foreground sm:px-6">Every printer uses the default prices.</p>
      ) : (
        <ul>
          {own.map(([printerId, list]) => (
            <li key={printerId} className="flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[0.9375rem] font-medium">{nameOf(printerId)}</span>
                <span className="text-sm text-muted-foreground">{priceSummary(list, prices.currency)}</span>
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ printerId })}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={set.isPending} onClick={() => set.mutate({ printers: { [printerId]: null } })}>
                    Use default
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <PrinterPriceDialog ws={ws} prices={prices} printerId={editing.printerId} choices={choices} onClose={() => setEditing(null)} />}
    </Section>
  )
}
