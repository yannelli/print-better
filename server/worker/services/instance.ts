import type { InstanceInfo, InstanceSettings } from '../../shared/types'
import { discover } from '../auth/oidc/discovery'
import type { Json } from '../http/body'
import { badRequest } from '../http/errors'
import { nullableStr, optBool, optObj, optOneOf } from '../http/validate'
import { VERSION } from '../version'
import { requireInstanceAdmin, requireScope } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import {
  appName,
  loadInstance,
  outboundEnabled,
  saveConfig,
  setSecret,
  setupRequired,
  type Instance,
  type InstanceConfig,
  type SecretSlot,
} from './instance-store'

const FROM = { max: 320, pattern: /^(?:[^<>]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/, hint: 'from must be an address like "Print Better <print@example.com>"' }
const DOMAIN = { max: 253, pattern: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i, hint: 'inboundDomain must be a domain name' }
const ISSUER = { max: 500, pattern: /^https:\/\/[^\s]+$/, hint: 'issuer must be an https URL' }

export function ssoProviders(inst: Instance): InstanceInfo['sso'] {
  const { google, oidc } = inst.config.sso
  const out: InstanceInfo['sso'] = []
  if (google.enabled && google.clientId && inst.secrets.has('sso.google.clientSecret')) out.push({ id: 'google', name: 'Google' })
  if (oidc.enabled && oidc.issuer && oidc.clientId && inst.secrets.has('sso.oidc.clientSecret')) {
    out.push({ id: 'oidc', name: oidc.name ?? 'Single sign-on' })
  }
  return out
}

export async function instanceInfo(env: Env): Promise<InstanceInfo> {
  const [inst, setup] = await Promise.all([loadInstance(env), setupRequired(env)])
  return {
    appName: appName(env, inst),
    version: VERSION,
    setupRequired: setup,
    signup: inst.config.signup,
    sso: ssoProviders(inst),
    emailEnabled: outboundEnabled(env, inst),
  }
}

function toSettings(env: Env, inst: Instance): InstanceSettings {
  const { config: c, secrets } = inst
  return {
    appName: appName(env, inst),
    signup: c.signup,
    sso: {
      google: { ...c.sso.google, hasSecret: secrets.has('sso.google.clientSecret') },
      oidc: { ...c.sso.oidc, hasSecret: secrets.has('sso.oidc.clientSecret') },
    },
    email: { ...c.email, hasApiKey: secrets.has('email.apiKey'), hasWebhookSecret: secrets.has('email.webhookSecret') },
  }
}

export async function getInstanceSettings(ctx: Ctx): Promise<InstanceSettings> {
  requireScope(ctx, 'read')
  requireInstanceAdmin(ctx)
  return toSettings(ctx.env, await loadInstance(ctx.env))
}

/** Deep-partial patch; secret fields are write-only: a string sets, null clears, omitted keeps. */
export async function patchInstanceSettings(ctx: Ctx, body: Json): Promise<InstanceSettings> {
  requireScope(ctx, 'write')
  requireInstanceAdmin(ctx)
  const inst = await loadInstance(ctx.env)
  const c: InstanceConfig = structuredClone(inst.config)
  const secretChanges = new Map<SecretSlot, string | null>()
  const setIf = <T>(value: T | undefined, apply: (v: T) => void) => value !== undefined && apply(value)

  setIf(nullableStr(body, 'appName', { max: 60 }), (v) => (c.appName = v))
  setIf(optOneOf(body, 'signup', ['invite', 'open'] as const), (v) => (c.signup = v))
  const sso = optObj(body, 'sso')
  const google = sso && optObj(sso, 'google')
  if (google) {
    setIf(optBool(google, 'enabled'), (v) => (c.sso.google.enabled = v))
    setIf(nullableStr(google, 'clientId', { max: 300 }), (v) => (c.sso.google.clientId = v))
    setIf(nullableStr(google, 'clientSecret', { max: 500 }), (v) => secretChanges.set('sso.google.clientSecret', v))
  }
  const oidc = sso && optObj(sso, 'oidc')
  if (oidc) {
    setIf(optBool(oidc, 'enabled'), (v) => (c.sso.oidc.enabled = v))
    setIf(nullableStr(oidc, 'name', { max: 60 }), (v) => (c.sso.oidc.name = v))
    setIf(nullableStr(oidc, 'issuer', ISSUER), (v) => (c.sso.oidc.issuer = v))
    setIf(nullableStr(oidc, 'clientId', { max: 300 }), (v) => (c.sso.oidc.clientId = v))
    setIf(nullableStr(oidc, 'clientSecret', { max: 500 }), (v) => secretChanges.set('sso.oidc.clientSecret', v))
  }
  const email = optObj(body, 'email')
  if (email) {
    setIf(optOneOf(email, 'provider', ['none', 'resend', 'cloudflare'] as const), (v) => (c.email.provider = v))
    setIf(nullableStr(email, 'from', FROM), (v) => (c.email.from = v))
    setIf(optOneOf(email, 'inbound', ['none', 'cloudflare', 'resend'] as const), (v) => (c.email.inbound = v))
    setIf(nullableStr(email, 'inboundDomain', DOMAIN), (v) => (c.email.inboundDomain = v?.toLowerCase() ?? null))
    setIf(nullableStr(email, 'apiKey', { max: 500 }), (v) => secretChanges.set('email.apiKey', v))
    setIf(nullableStr(email, 'webhookSecret', { max: 500 }), (v) => secretChanges.set('email.webhookSecret', v))
  }

  const has = (slot: SecretSlot) => (secretChanges.has(slot) ? secretChanges.get(slot) !== null : inst.secrets.has(slot))
  if (c.sso.google.enabled && (!c.sso.google.clientId || !has('sso.google.clientSecret'))) {
    throw badRequest('Google sign-in needs a client ID and client secret')
  }
  if (c.sso.oidc.enabled) {
    if (!c.sso.oidc.issuer || !c.sso.oidc.clientId || !has('sso.oidc.clientSecret')) {
      throw badRequest('OIDC sign-in needs an issuer, client ID and client secret')
    }
    if (c.sso.oidc.issuer !== inst.config.sso.oidc.issuer || !inst.config.sso.oidc.enabled) await discover(c.sso.oidc.issuer)
  }
  if (c.email.provider === 'resend' && (!c.email.from || !has('email.apiKey'))) throw badRequest('Resend needs a from address and API key')
  if (c.email.provider === 'cloudflare' && (!c.email.from || !ctx.env.EMAIL)) {
    throw badRequest('Cloudflare email needs a from address and the EMAIL send_email binding')
  }
  if (c.email.inbound === 'resend' && (!has('email.apiKey') || !has('email.webhookSecret'))) {
    throw badRequest('Resend inbound needs an API key and the webhook signing secret')
  }

  await saveConfig(ctx.env, c)
  for (const [slot, value] of secretChanges) await setSecret(ctx.env, slot, value)
  await audit(ctx, null, 'instance.update', null, { fields: Object.keys(body) })
  return toSettings(ctx.env, await loadInstance(ctx.env))
}
