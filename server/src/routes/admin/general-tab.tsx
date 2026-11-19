import type { InstanceSettings } from '@shared/types'
import { OptionCards } from '@/components/option-cards'
import { Row, Section } from '@/components/page'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUpdateAdminSettings } from '@/hooks/account'
import { useDraft } from '../settings/draft'
import { Block, SaveBar } from '../settings/fields'

export function GeneralTab({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateAdminSettings()
  const { draft, dirty, set, reset, changes } = useDraft({ appName: settings.appName, signup: settings.signup })
  const nameMissing = !draft.appName.trim()

  const save = () => {
    const c = changes()
    update.mutate({ ...c, ...(c.appName !== undefined && { appName: c.appName.trim() }) })
  }

  return (
    <Section id="general" title="This server" flush>
      <Row label="Name" htmlFor="admin-app-name" description="Shown on the sign-in page and in emails.">
        <div className="flex w-full flex-col gap-1.5 sm:w-72">
          <Input
            id="admin-app-name"
            value={draft.appName}
            onChange={(e) => set({ appName: e.target.value })}
            maxLength={60}
            aria-invalid={nameMissing || undefined}
          />
          {nameMissing && <FieldError>Give the server a name.</FieldError>}
        </div>
      </Row>
      <Block>
        <span className="text-[0.9375rem] font-medium">Who can create an account</span>
        <OptionCards<InstanceSettings['signup']>
          label="Who can create an account"
          columns={2}
          value={draft.signup}
          onChange={(signup) => set({ signup })}
          options={[
            { value: 'invite', label: 'Only people with an invite link', description: 'Recommended. Workspace admins send invites.' },
            { value: 'open', label: 'Anyone with the address', description: 'New people can sign up and make their own workspace.' },
          ]}
        />
      </Block>
      <SaveBar dirty={dirty} pending={update.isPending} onSave={save} onReset={reset} disabled={nameMissing} />
    </Section>
  )
}
