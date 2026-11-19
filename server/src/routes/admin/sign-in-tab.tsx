import type { InstanceSettings } from '@shared/types'
import { CopyField } from '@/components/copy'
import { Row, Section } from '@/components/page'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useUpdateAdminSettings } from '@/hooks/account'
import { useDraft } from '../settings/draft'
import { Block, SaveBar } from '../settings/fields'
import { SecretField, useSecret } from './secret-field'

type Provider = 'google' | 'oidc'

const COPY: Record<Provider, { title: string; description: string }> = {
  google: {
    title: 'Sign in with Google',
    description:
      'In Google Cloud Console, open APIs and Services, then Credentials, and create an OAuth client of type Web application. Add the redirect address below to it.',
  },
  oidc: {
    title: 'Sign in with your organization',
    description:
      'Works with Microsoft Entra ID, Okta, Authentik, Keycloak and other OpenID Connect providers. Register an app there with the redirect address below.',
  },
}

function ProviderSection({ provider, settings }: { provider: Provider; settings: InstanceSettings }) {
  const sso = settings.sso
  const saved = sso[provider]
  const update = useUpdateAdminSettings()
  const secret = useSecret()
  const { draft, dirty, set, reset, changes } = useDraft({
    enabled: saved.enabled,
    clientId: saved.clientId ?? '',
    name: sso.oidc.name ?? '',
    issuer: sso.oidc.issuer ?? '',
  })
  const isOidc = provider === 'oidc'
  const willHaveSecret = secret.clear ? false : saved.hasSecret || secret.value.trim().length > 0
  const errors = draft.enabled
    ? {
        clientId: draft.clientId.trim() ? null : 'Enter the client ID.',
        secret: willHaveSecret ? null : 'Enter the client secret.',
        issuer: !isOidc || /^https:\/\/\S+$/.test(draft.issuer.trim()) ? null : 'Enter the https address of your provider.',
        name: !isOidc || draft.name.trim() ? null : 'Enter a name for the sign-in button.',
      }
    : { clientId: null, secret: null, issuer: null, name: null }
  const invalid = Object.values(errors).some(Boolean)

  const save = () => {
    const c = changes()
    const clientSecret = secret.patch()
    const patch = {
      ...(c.enabled !== undefined && { enabled: c.enabled }),
      ...(c.clientId !== undefined && { clientId: c.clientId.trim() || null }),
      ...(isOidc && c.name !== undefined && { name: c.name.trim() || null }),
      ...(isOidc && c.issuer !== undefined && { issuer: c.issuer.trim() || null }),
      ...(clientSecret !== undefined && { clientSecret }),
    }
    update.mutate({ sso: { [provider]: patch } }, { onSuccess: secret.reset })
  }

  const text = (key: 'clientId' | 'name' | 'issuer', label: string, placeholder?: string, help?: string) => (
    <Field data-invalid={errors[key] ? true : undefined}>
      <FieldLabel htmlFor={`${provider}-${key}`}>{label}</FieldLabel>
      <Input
        id={`${provider}-${key}`}
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={errors[key] ? true : undefined}
        className="sm:max-w-md"
      />
      {help && <FieldDescription>{help}</FieldDescription>}
      {errors[key] && <FieldError>{errors[key]}</FieldError>}
    </Field>
  )

  return (
    <Section id={`sso-${provider}`} title={COPY[provider].title} description={COPY[provider].description} flush>
      <Row label="Show this option on the sign-in page" htmlFor={`${provider}-enabled`}>
        <Switch id={`${provider}-enabled`} checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
      </Row>
      <Block>
        {isOidc && text('name', 'Button name', 'Company account', 'People see “Sign in with” followed by this.')}
        {isOidc && text('issuer', 'Issuer address', 'https://login.example.com')}
        {text('clientId', 'Client ID')}
        <SecretField id={`${provider}-secret`} label="Client secret" saved={saved.hasSecret} secret={secret} />
        {errors.secret && <FieldError>{errors.secret}</FieldError>}
        <CopyField label="Redirect address" value={`${location.origin}/api/auth/sso/${provider}/callback`} />
      </Block>
      <SaveBar
        dirty={dirty || secret.dirty}
        pending={update.isPending}
        onSave={save}
        onReset={() => {
          reset()
          secret.reset()
        }}
        disabled={invalid}
      />
    </Section>
  )
}

export function SignInTab({ settings }: { settings: InstanceSettings }) {
  return (
    <div className="flex flex-col gap-10">
      <p className="max-w-prose px-1 text-[0.9375rem] text-muted-foreground">
        Optional. Passwords and passkeys always work. Single sign-on adds a button to the sign-in page; people still need an invite unless
        anyone can sign up.
      </p>
      <ProviderSection provider="google" settings={settings} />
      <ProviderSection provider="oidc" settings={settings} />
    </div>
  )
}
