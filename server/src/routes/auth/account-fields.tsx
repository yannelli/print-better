import { Fingerprint, KeyRound } from 'lucide-react'
import { OptionCards } from '@/components/option-cards'
import { passkeysSupported } from '@/lib/webauthn'
import { MIN_PASSWORD, PasswordField, passwordProblem, TextField } from './fields'

export type SignInMethod = 'password' | 'passkey'

export interface AccountDraft {
  name: string
  username: string
  email: string
  password: string
  method: SignInMethod
}

export type AccountErrors = Partial<Record<'name' | 'username' | 'email' | 'password', string>>

export const emptyAccount = (): AccountDraft => ({ name: '', username: '', email: '', password: '', method: 'password' })

const suggestUsername = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32)

export function accountErrors(draft: AccountDraft, opts: { email?: boolean } = {}): AccountErrors {
  const errors: AccountErrors = {}
  if (!draft.name.trim()) errors.name = 'Enter your name.'
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(draft.username.trim())) {
    errors.username = 'Use 2 to 32 letters, numbers, dots, dashes or underscores. No spaces.'
  }
  if (opts.email && draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    errors.email = 'That email address looks incomplete.'
  }
  if (draft.method === 'password') {
    const problem = passwordProblem(draft.password)
    if (problem) errors.password = problem
  }
  return errors
}

/** Name, username, optional email, and a choice of password or passkey. */
export function AccountFields({
  draft,
  onChange,
  errors,
  showEmail,
}: {
  draft: AccountDraft
  onChange: (draft: AccountDraft) => void
  errors: AccountErrors
  showEmail?: boolean
}) {
  const set = (patch: Partial<AccountDraft>) => onChange({ ...draft, ...patch })
  const onName = (name: string) => {
    const usernameUntouched = draft.username === suggestUsername(draft.name)
    set(usernameUntouched ? { name, username: suggestUsername(name) } : { name })
  }
  return (
    <div className="flex flex-col gap-5">
      <TextField id="name" label="Your name" autoComplete="name" value={draft.name} onChange={(e) => onName(e.target.value)} error={errors.name} required />
      <TextField
        id="username"
        label="Username"
        description="You'll use this to sign in."
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={draft.username}
        onChange={(e) => set({ username: e.target.value })}
        error={errors.username}
        required
      />
      {showEmail && (
        <TextField
          id="email"
          type="email"
          label="Email (optional)"
          description="Only used for invites and password resets."
          autoComplete="email"
          value={draft.email}
          onChange={(e) => set({ email: e.target.value })}
          error={errors.email}
        />
      )}
      {passkeysSupported() && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-[0.9375rem] font-medium">How do you want to sign in?</legend>
          <OptionCards<SignInMethod>
            label="How do you want to sign in?"
            columns={2}
            value={draft.method}
            onChange={(method) => set({ method })}
            options={[
              { value: 'password', label: 'Password', description: 'A password you type', media: <KeyRound /> },
              { value: 'passkey', label: 'Passkey', description: 'Your fingerprint, face or device PIN', media: <Fingerprint /> },
            ]}
          />
        </fieldset>
      )}
      {draft.method === 'password' && (
        <PasswordField
          id="new-password"
          label="Password"
          description={`At least ${MIN_PASSWORD} characters. A short sentence is easy to remember.`}
          autoComplete="new-password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
          error={errors.password}
          required
        />
      )}
    </div>
  )
}
