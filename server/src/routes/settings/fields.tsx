import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export interface Choice<T extends string> {
  value: T
  label: string
  description?: ReactNode
}

/** A labelled single-choice Select whose trigger always shows the readable label, not the raw value. */
export function ChoiceSelect<T extends string>({
  id,
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  className,
}: {
  id?: string
  value: T
  onChange: (value: T) => void
  options: Choice<T>[]
  disabled?: boolean
  ariaLabel?: string
  className?: string
}) {
  return (
    <Select
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value}
      onValueChange={(next) => next !== null && onChange(next as T)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full sm:w-64', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.description ? (
              <span className="flex flex-col gap-0.5 whitespace-normal">
                <span>{o.label}</span>
                <span className="text-sm text-muted-foreground">{o.description}</span>
              </span>
            ) : (
              o.label
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Footer of an editable section: says when there are unsaved changes and offers Save and Undo. */
export function SaveBar({
  dirty,
  pending,
  onSave,
  onReset,
  disabled,
  label = 'Save changes',
}: {
  dirty: boolean
  pending: boolean
  onSave: () => void
  onReset: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t bg-surface px-5 py-4 sm:px-6">
      <span role="status" className="mr-auto text-sm text-muted-foreground">
        {dirty ? 'You have unsaved changes' : ''}
      </span>
      {dirty && (
        <Button type="button" variant="ghost" onClick={onReset} disabled={pending}>
          Undo
        </Button>
      )}
      <Button type="button" onClick={onSave} disabled={!dirty || pending || disabled}>
        {pending && <Spinner data-icon="inline-start" />}
        {label}
      </Button>
    </div>
  )
}

/** Shown on settings that only admins can change. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-muted px-5 py-3.5 text-[0.9375rem] text-muted-foreground">{children}</p>
}

/** Wraps a block of custom content inside a flush Section so it lines up with Rows. */
export function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-4 border-b px-5 py-5 last:border-b-0 sm:px-6', className)}>{children}</div>
}
