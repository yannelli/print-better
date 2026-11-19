import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { cn } from '@/lib/utils'

export interface SearchChoice {
  value: string
  label: string
}

/** A searchable single choice from a long list, such as currencies or time zones. */
export function SearchSelect({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  options: SearchChoice[]
  disabled?: boolean
}) {
  return (
    <Combobox<SearchChoice>
      items={options}
      value={options.find((o) => o.value === value) ?? null}
      onValueChange={(o) => o && o.value !== value && onChange(o.value)}
      itemToStringLabel={(o) => o.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        data-focus-ring="none"
        disabled={disabled}
        className={cn(
          'h-11 w-full rounded-2xl bg-background px-1.5 sm:w-72 [&_input]:text-base',
          'has-[input:focus-visible]:outline-[2.5px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-solid',
        )}
      />
      <ComboboxContent>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(o: SearchChoice) => (
            <ComboboxItem key={o.value} value={o}>
              {o.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

const currencyNames = new Intl.DisplayNames(undefined, { type: 'currency' })

export const CURRENCIES: SearchChoice[] = Intl.supportedValuesOf('currency').map((code) => ({ value: code, label: `${currencyNames.of(code) ?? code} (${code})` }))

/** Every IANA time zone the browser knows, plus the saved one in case it doesn't. */
export function timeZoneChoices(current: string): SearchChoice[] {
  const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone'), current])
  return [...zones].map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))
}
