import { Eye, EyeOff } from 'lucide-react'
import { type ComponentProps, type ReactNode, useCallback, useState } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/api/http'

type InputProps = Omit<ComponentProps<'input'>, 'id'> & { id: string }

/** Label, input, help and error wired together with the right aria attributes. */
export function TextField({
  label,
  description,
  error,
  ...input
}: InputProps & { label: ReactNode; description?: ReactNode; error?: string | null }) {
  const helpId = `${input.id}-help`
  const errorId = `${input.id}-error`
  const describedBy = [description && helpId, error && errorId].filter(Boolean).join(' ') || undefined
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={input.id}>{label}</FieldLabel>
      <Input {...input} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}

export function PasswordField({
  label = 'Password',
  description,
  error,
  ...input
}: InputProps & { label?: ReactNode; description?: ReactNode; error?: string | null }) {
  const [visible, setVisible] = useState(false)
  const helpId = `${input.id}-help`
  const errorId = `${input.id}-error`
  const describedBy = [description && helpId, error && errorId].filter(Boolean).join(' ') || undefined
  const Icon = visible ? EyeOff : Eye
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={input.id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          {...input}
          type={visible ? 'text' : 'password'}
          className="pr-14"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="press absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon className="size-5" />
        </button>
      </div>
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}

export const MIN_PASSWORD = 8

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (confirm !== undefined && password !== confirm) return "The two passwords don't match."
  return null
}

/** Tracks one async form submission: pending flag plus a plain-language error. */
export function useSubmit() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (task: () => Promise<unknown>) => {
    setPending(true)
    setError(null)
    try {
      await task()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setPending(false)
    }
  }, [])
  return { pending, error, setError, run }
}
