import type { Member } from '@shared/types'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '@/components/ui/combobox'
import { useMembers } from '@/hooks/members'

/** Several members by name, for who gets alerts and reports. */
export function MemberPicker({
  id,
  ws,
  value,
  onChange,
  disabled,
  placeholder = 'Add people',
}: {
  id?: string
  ws: string
  value: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  placeholder?: string
}) {
  const members = useMembers(ws).data ?? []
  const anchor = useComboboxAnchor()
  const selected = members.filter((m) => value.includes(m.userId))
  return (
    <Combobox
      multiple
      items={members}
      value={selected}
      onValueChange={(next: Member[]) => onChange(next.map((m) => m.userId))}
      itemToStringLabel={(m: Member) => m.name}
      isItemEqualToValue={(a: Member, b: Member) => a.userId === b.userId}
      disabled={disabled}
    >
      <ComboboxChips ref={anchor} className="min-h-11 w-full rounded-2xl bg-background px-2 sm:w-80">
        <ComboboxValue>
          {(chosen: Member[]) => (
            <>
              {chosen.map((m) => (
                <ComboboxChip key={m.userId}>{m.name}</ComboboxChip>
              ))}
              <ComboboxChipsInput id={id} placeholder={chosen.length ? '' : placeholder} className="px-1.5 text-base sm:text-[0.9375rem]" />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No one matches</ComboboxEmpty>
        <ComboboxList>
          {(m: Member) => (
            <ComboboxItem key={m.userId} value={m}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{m.name}</span>
                <span className="truncate text-xs text-muted-foreground">{m.email ?? 'No email address'}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
