import { Check } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { AccountFields, type AccountDraft, accountErrors } from './account-fields'
import { FormError } from './auth-layout'
import { TextField } from './fields'

const STEPS = ['Your account', 'Name your place', 'Add a device']

export function StepIndicator({ current }: { current: number }) {
  return (
    <ol aria-label="Setup steps" className="flex flex-wrap gap-x-5 gap-y-2">
      {STEPS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} aria-current={active ? 'step' : undefined} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-full border text-sm font-semibold tabular',
                done && 'border-transparent bg-ok-container text-on-ok-container',
                active && 'border-transparent bg-brand text-brand-foreground',
                !done && !active && 'text-muted-foreground',
              )}
            >
              {done ? <Check className="size-4" aria-label="Done" /> : i + 1}
            </span>
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-4">
        {[
          ['Create your account', 'You will be the owner of this server.'],
          ['Name the place your printers are', 'Like Home or Office.'],
          ['Connect a computer near your printers', 'It finds the printers for you.'],
        ].map(([title, help], i) => (
          <li key={title} className="flex items-start gap-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-[0.9375rem] font-semibold tabular">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5 pt-1">
              <span className="text-base font-medium">{title}</span>
              <span className="text-sm text-muted-foreground">{help}</span>
            </span>
          </li>
        ))}
      </ol>
      <Button size="lg" className="w-full" onClick={onNext} autoFocus>
        Get started
      </Button>
    </div>
  )
}

export function AccountStep({
  draft,
  onChange,
  setupToken,
  onSetupToken,
  tokenError,
  showToken,
  onNext,
}: {
  draft: AccountDraft
  onChange: (draft: AccountDraft) => void
  setupToken: string
  onSetupToken: (value: string) => void
  tokenError: string | null
  /** Hidden when the setup link already carried the code. */
  showToken: boolean
  onNext: () => void
}) {
  const [attempted, setAttempted] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (Object.keys(accountErrors(draft)).length === 0) onNext()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <AccountFields draft={draft} onChange={onChange} errors={attempted ? accountErrors(draft) : {}} />
      {showToken && (
        <TextField
          id="setup-code"
          label="Setup code"
          description="The SETUP_TOKEN secret chosen when this server was deployed. Leave empty if none was set."
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          value={setupToken}
          onChange={(e) => onSetupToken(e.target.value)}
          error={tokenError}
        />
      )}
      <Button type="submit" size="lg" className="w-full">
        Continue
      </Button>
    </form>
  )
}

export function WorkspaceStep({
  name,
  onName,
  pending,
  error,
  passkey,
  onBack,
  onSubmit,
}: {
  name: string
  onName: (value: string) => void
  pending: boolean
  error: string | null
  passkey: boolean
  onBack: () => void
  onSubmit: () => void
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onSubmit()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <TextField
        id="workspace-name"
        label="Name this place"
        description="Printers, devices and people are grouped by place. You can add more later."
        value={name}
        onChange={(e) => onName(e.target.value)}
        maxLength={80}
        required
        autoFocus
      />
      <FormError message={error} />
      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={pending || !name.trim()}>
          {pending && <Spinner data-icon="inline-start" />}
          {passkey ? 'Create account and passkey' : 'Create account'}
        </Button>
        <Button type="button" variant="ghost" size="lg" className="w-full" onClick={onBack} disabled={pending}>
          Back
        </Button>
      </div>
    </form>
  )
}
