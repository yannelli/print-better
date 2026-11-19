import { LaptopMinimal, type LucideIcon, UserRound, Users, UsersRound } from 'lucide-react'
import { useMemo } from 'react'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from '@/components/ui/combobox'
import { cn } from '@/lib/utils'
import { type SubjectGroup, type SubjectKind, type SubjectOption, type SubjectSources, subjectGroups } from './subjects'

export const SUBJECT_ICONS: Record<SubjectKind, LucideIcon> = {
  everyone: UsersRound,
  user: UserRound,
  group: Users,
  client: LaptopMinimal,
}

export function SubjectIcon({ type, className }: { type: SubjectKind; className?: string }) {
  const Icon = SUBJECT_ICONS[type]
  return (
    <span aria-hidden className={cn('flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground', className)}>
      <Icon className="size-4.5" />
    </span>
  )
}

/** Searchable choice of who to give access to (or check): everyone, people, groups, devices. */
export function SubjectPicker({
  id,
  sources,
  kinds,
  exclude,
  value,
  onChange,
  placeholder = 'Search people, groups, or devices',
  disabled,
  className,
}: {
  id?: string
  sources: SubjectSources
  kinds: readonly SubjectKind[]
  exclude?: ReadonlySet<string>
  value: SubjectOption | null
  onChange: (value: SubjectOption | null) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const groups = useMemo(() => subjectGroups(sources, kinds, exclude), [sources, kinds, exclude])
  return (
    <Combobox<SubjectOption>
      items={groups}
      value={value}
      onValueChange={onChange}
      itemToStringLabel={(o) => o.label}
      isItemEqualToValue={(a, b) => a.key === b.key}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        disabled={disabled}
        className={cn('h-11 w-full rounded-2xl bg-background px-1.5 [&_input]:text-base', className)}
      />
      <ComboboxContent>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(group: SubjectGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: SubjectOption) => (
                  <ComboboxItem key={item.key} value={item}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[0.9375rem]">{item.label}</span>
                      {item.detail && <span className="truncate text-sm text-muted-foreground">{item.detail}</span>}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
