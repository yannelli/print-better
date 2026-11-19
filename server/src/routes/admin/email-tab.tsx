import type { InstanceSettings } from '@shared/types'
import { CopyField } from '@/components/copy'
import { OptionCards } from '@/components/option-cards'
import { Section } from '@/components/page'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUpdateAdminSettings } from '@/hooks/account'
import { useDraft } from '../settings/draft'
import { Block, SaveBar } from '../settings/fields'
import { SecretField, useSecret } from './secret-field'

type Email = InstanceSettings['email']

function OutgoingSection({ email }: { email: Email }) {
  const update = useUpdateAdminSettings()
  const apiKey = useSecret()
  const { draft, dirty, set, reset, changes } = useDraft({ provider: email.provider, from: email.from ?? '' })
  const fromInvalid = draft.provider !== 'none' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.from.trim().replace(/^.*<(.+)>$/, '$1'))
  const keyMissing = draft.provider === 'resend' && !(apiKey.clear ? false : email.hasApiKey || apiKey.value.trim())

  const save = () => {
    const c = changes()
    const key = apiKey.patch()
    update.mutate(
      {
        email: {
          ...(c.provider !== undefined && { provider: c.provider }),
          ...(c.from !== undefined && { from: c.from.trim() || null }),
          ...(key !== undefined && { apiKey: key }),
        },
      },
      { onSuccess: apiKey.reset },
    )
  }

  return (
    <Section
      id="email-out"
      title="Sending email"
      description="Used for invites, password resets and printer alerts. Without it, you share invite links yourself and people reset passwords with recovery codes."
      flush
    >
      <Block>
        <OptionCards<Email['provider']>
          label="How to send email"
          value={draft.provider}
          onChange={(provider) => set({ provider })}
          options={[
            { value: 'none', label: 'Don’t send email' },
            { value: 'resend', label: 'Resend', description: 'Needs a Resend API key' },
            { value: 'cloudflare', label: 'Cloudflare Email', description: 'Uses this Worker’s email sending' },
          ]}
        />
      </Block>
      {draft.provider !== 'none' && (
        <Block>
          <Field data-invalid={fromInvalid || undefined}>
            <FieldLabel htmlFor="email-from">Send from</FieldLabel>
            <Input
              id="email-from"
              value={draft.from}
              onChange={(e) => set({ from: e.target.value })}
              placeholder="Print Better <print@example.com>"
              autoComplete="off"
              aria-invalid={fromInvalid || undefined}
              className="sm:max-w-md"
            />
            <FieldDescription>The address must belong to a domain you set up with your email provider.</FieldDescription>
            {fromInvalid && <FieldError>Enter an email address, optionally with a name in front.</FieldError>}
          </Field>
          {draft.provider === 'resend' && (
            <>
              <SecretField id="email-api-key" label="Resend API key" saved={email.hasApiKey} secret={apiKey} />
              {keyMissing && <FieldError>Enter the API key.</FieldError>}
            </>
          )}
        </Block>
      )}
      <SaveBar
        dirty={dirty || apiKey.dirty}
        pending={update.isPending}
        onSave={save}
        onReset={() => {
          reset()
          apiKey.reset()
        }}
        disabled={fromInvalid || keyMissing}
      />
    </Section>
  )
}

function IncomingSection({ email }: { email: Email }) {
  const update = useUpdateAdminSettings()
  const webhook = useSecret()
  const { draft, dirty, set, reset, changes } = useDraft({ inbound: email.inbound, inboundDomain: email.inboundDomain ?? '' })
  const domainInvalid = draft.inbound !== 'none' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(draft.inboundDomain.trim())

  const save = () => {
    const c = changes()
    const secret = webhook.patch()
    update.mutate(
      {
        email: {
          ...(c.inbound !== undefined && { inbound: c.inbound }),
          ...(c.inboundDomain !== undefined && { inboundDomain: c.inboundDomain.trim().toLowerCase() || null }),
          ...(secret !== undefined && { webhookSecret: secret }),
        },
      },
      { onSuccess: webhook.reset },
    )
  }

  return (
    <Section
      id="email-in"
      title="Receiving email"
      description="Lets people print by emailing a document. Each printer gets its own address at your domain, and each workspace decides who may use it."
      flush
    >
      <Block>
        <OptionCards<Email['inbound']>
          label="How email arrives"
          value={draft.inbound}
          onChange={(inbound) => set({ inbound })}
          options={[
            { value: 'none', label: 'Off' },
            { value: 'cloudflare', label: 'Cloudflare Email Routing', description: 'Route the domain’s mail to this Worker' },
            { value: 'resend', label: 'Resend', description: 'Resend forwards mail to a webhook' },
          ]}
        />
      </Block>
      {draft.inbound !== 'none' && (
        <Block>
          <Field data-invalid={domainInvalid || undefined}>
            <FieldLabel htmlFor="email-domain">Email domain for printers</FieldLabel>
            <Input
              id="email-domain"
              value={draft.inboundDomain}
              onChange={(e) => set({ inboundDomain: e.target.value })}
              placeholder="print.example.com"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={domainInvalid || undefined}
              className="font-mono sm:max-w-md"
            />
            <FieldDescription>Printers get addresses like kitchen@{draft.inboundDomain.trim() || 'print.example.com'}.</FieldDescription>
            {domainInvalid && <FieldError>Enter a domain name, like print.example.com.</FieldError>}
          </Field>
          {draft.inbound === 'resend' && (
            <>
              <CopyField label="Webhook address to give Resend" value={`${location.origin}/api/hooks/resend`} />
              <SecretField
                id="email-webhook-secret"
                label="Webhook signing secret"
                saved={email.hasWebhookSecret}
                secret={webhook}
                description="Shown in Resend after you add the webhook. It starts with whsec_."
              />
            </>
          )}
        </Block>
      )}
      <SaveBar
        dirty={dirty || webhook.dirty}
        pending={update.isPending}
        onSave={save}
        onReset={() => {
          reset()
          webhook.reset()
        }}
        disabled={domainInvalid}
      />
    </Section>
  )
}

export function EmailTab({ settings }: { settings: InstanceSettings }) {
  return (
    <div className="flex flex-col gap-10">
      <OutgoingSection email={settings.email} />
      <IncomingSection email={settings.email} />
    </div>
  )
}
