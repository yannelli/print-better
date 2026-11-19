import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/** Draft for a write-only secret: typed text sets it, `clear` removes it, otherwise it stays as saved. */
export function useSecret() {
  const [value, setValue] = useState('')
  const [clear, setClear] = useState(false)
  return {
    value,
    clear,
    dirty: clear || value.length > 0,
    setValue: (next: string) => {
      setValue(next)
      setClear(false)
    },
    setClear: (next: boolean) => {
      setClear(next)
      if (next) setValue('')
    },
    reset: () => {
      setValue('')
      setClear(false)
    },
    /** Patch value: string to set, null to clear, undefined to leave unchanged. */
    patch: (): string | null | undefined => (clear ? null : value.trim() || undefined),
  }
}

export type Secret = ReturnType<typeof useSecret>

export function SecretField({
  id,
  label,
  saved,
  secret,
  description,
}: {
  id: string
  label: string
  saved: boolean
  secret: Secret
  description?: string
}) {
  const help = secret.clear ? 'This will be removed when you save.' : description
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secret.value}
          onChange={(e) => secret.setValue(e.target.value)}
          placeholder={saved && !secret.clear ? 'Saved. Type a new one to replace it' : secret.clear ? 'Will be removed' : ''}
          disabled={secret.clear}
          aria-describedby={help ? `${id}-help` : undefined}
          className="min-w-0 flex-1 font-mono sm:max-w-md"
        />
        {saved &&
          (secret.clear ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => secret.setClear(false)}>
              Keep it
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => secret.setClear(true)}>
              Remove
            </Button>
          ))}
      </div>
      {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
    </Field>
  )
}
