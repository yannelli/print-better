import { Palette } from 'lucide-react'
import type { User } from '@shared/types'
import { Row, Section } from '@/components/page'
import { useAppActions } from '@/components/shell/app-actions'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUpdateMe } from '@/hooks/account'
import { useDraft } from '../settings/draft'
import { SaveBar } from '../settings/fields'
import { EmailStatusRow } from './email-status'

const USERNAME = /^[A-Za-z0-9._-]{2,32}$/

export function ProfileTab({ user }: { user: User }) {
  const update = useUpdateMe()
  const { openCustomize } = useAppActions()
  const { draft, dirty, set, reset, changes } = useDraft({ name: user.name, username: user.username, email: user.email ?? '' })
  const errors = {
    name: draft.name.trim() ? null : 'Enter your name.',
    username: draft.username === user.username || USERNAME.test(draft.username) ? null : 'Use 2 to 32 letters, numbers, dots, dashes or underscores.',
    email: !draft.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email) ? null : 'That doesn’t look like an email address.',
  }
  const invalid = Object.values(errors).some(Boolean)

  const save = () => {
    const c = changes()
    update.mutate({
      ...(c.name !== undefined && { name: c.name.trim() }),
      ...(c.username !== undefined && { username: c.username.trim() }),
      ...(c.email !== undefined && { email: c.email.trim() || null }),
    })
  }

  const field = (key: keyof typeof draft, props: { label: string; type?: string; autoComplete: string; description?: string }) => (
    <Row label={props.label} htmlFor={`me-${key}`} description={props.description}>
      <div className="flex w-full flex-col gap-1.5 sm:w-72">
        <Input
          id={`me-${key}`}
          type={props.type ?? 'text'}
          autoComplete={props.autoComplete}
          value={draft[key]}
          onChange={(e) => set({ [key]: e.target.value })}
          aria-invalid={errors[key] ? true : undefined}
        />
        {errors[key] && <FieldError>{errors[key]}</FieldError>}
      </div>
    </Row>
  )

  return (
    <div className="flex flex-col gap-10">
      <Section id="profile" title="Profile" flush>
        {field('name', { label: 'Your name', autoComplete: 'name', description: 'Shown to people in your workspaces.' })}
        {field('username', { label: 'Username', autoComplete: 'username', description: 'You can sign in with this.' })}
        {field('email', {
          label: 'Email',
          type: 'email',
          autoComplete: 'email',
          description: 'Optional. Used to sign in, reset your password and print by email.',
        })}
        {user.email && <EmailStatusRow email={user.email} verified={user.emailVerified} />}
        <SaveBar dirty={dirty} pending={update.isPending} onSave={save} onReset={reset} disabled={invalid} />
      </Section>
      <Section id="look" title="Look and feel" flush>
        <Row label="Theme, colors and text size" description="Saved on this device only.">
          <Button variant="outline" onClick={openCustomize}>
            <Palette data-icon="inline-start" />
            Customize the look
          </Button>
        </Row>
      </Section>
    </div>
  )
}
