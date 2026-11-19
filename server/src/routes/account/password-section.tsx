import { type FormEvent, useState } from 'react'
import type { User } from '@shared/types'
import { Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useSetPassword } from '@/hooks/account'
import { errorMessage } from '@/lib/api/http'

const MIN = 8

export function PasswordSection({ user }: { user: User }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const save = useSetPassword()

  const tooShort = next.length < MIN
  const mismatch = again !== next
  const missingCurrent = user.hasPassword && !current

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (tooShort || mismatch || missingCurrent) return
    save.mutate(
      { next, current: user.hasPassword ? current : undefined },
      {
        onSuccess: () => {
          setCurrent('')
          setNext('')
          setAgain('')
          setSubmitted(false)
        },
      },
    )
  }

  return (
    <Section
      id="password"
      title="Password"
      description={user.hasPassword ? undefined : 'You sign in without a password today. Adding one gives you a backup way in.'}
    >
      <form onSubmit={submit} className="flex max-w-md flex-col gap-5" noValidate>
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
        {user.hasPassword && (
          <Field data-invalid={(submitted && missingCurrent) || undefined}>
            <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={(submitted && missingCurrent) || undefined}
            />
            {submitted && missingCurrent && <FieldError>Enter the password you use now.</FieldError>}
          </Field>
        )}
        <Field data-invalid={(submitted && tooShort) || undefined}>
          <FieldLabel htmlFor="pw-next">New password</FieldLabel>
          <Input
            id="pw-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={(submitted && tooShort) || undefined}
            aria-describedby="pw-next-help"
          />
          <FieldDescription id="pw-next-help">At least {MIN} characters. A short sentence is easy to remember.</FieldDescription>
          {submitted && tooShort && <FieldError>Use at least {MIN} characters.</FieldError>}
        </Field>
        <Field data-invalid={(submitted && mismatch) || undefined}>
          <FieldLabel htmlFor="pw-again">Type it again</FieldLabel>
          <Input
            id="pw-again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={(submitted && mismatch) || undefined}
          />
          {submitted && mismatch && <FieldError>The two passwords don’t match.</FieldError>}
        </Field>
        {save.error && <FieldError>{errorMessage(save.error)}</FieldError>}
        <Button type="submit" className="self-start" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {user.hasPassword ? 'Change password' : 'Add a password'}
        </Button>
      </form>
    </Section>
  )
}
