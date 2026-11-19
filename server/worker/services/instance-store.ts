import { all, first, run } from '../lib/db'
import { decryptSecret, encryptSecret } from '../lib/secrets'

export interface InstanceConfig {
  appName: string | null
  signup: 'invite' | 'open'
  sso: {
    google: { enabled: boolean; clientId: string | null }
    oidc: { enabled: boolean; name: string | null; issuer: string | null; clientId: string | null }
  }
  email: {
    provider: 'none' | 'resend' | 'cloudflare'
    from: string | null
    inbound: 'none' | 'cloudflare' | 'resend'
    inboundDomain: string | null
  }
}

export const SECRET_SLOTS = ['sso.google.clientSecret', 'sso.oidc.clientSecret', 'email.apiKey', 'email.webhookSecret'] as const
export type SecretSlot = (typeof SECRET_SLOTS)[number]

export interface Instance {
  config: InstanceConfig
  secrets: Set<SecretSlot>
}

const DEFAULT_CONFIG: InstanceConfig = {
  appName: null,
  signup: 'invite',
  sso: {
    google: { enabled: false, clientId: null },
    oidc: { enabled: false, name: null, issuer: null, clientId: null },
  },
  email: { provider: 'none', from: null, inbound: 'none', inboundDomain: null },
}

const CONFIG_KEY = 'instance'
const secretKey = (slot: SecretSlot) => `secret:${slot}`

function mergeConfig(stored: Partial<InstanceConfig>): InstanceConfig {
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    sso: {
      google: { ...DEFAULT_CONFIG.sso.google, ...stored.sso?.google },
      oidc: { ...DEFAULT_CONFIG.sso.oidc, ...stored.sso?.oidc },
    },
    email: { ...DEFAULT_CONFIG.email, ...stored.email },
  }
}

export async function loadInstance(env: Env): Promise<Instance> {
  const rows = await all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings WHERE key = ? OR key LIKE 'secret:%'", CONFIG_KEY)
  let stored: Partial<InstanceConfig> = {}
  const secrets = new Set<SecretSlot>()
  for (const row of rows) {
    if (row.key === CONFIG_KEY) stored = JSON.parse(row.value) as Partial<InstanceConfig>
    else {
      const slot = SECRET_SLOTS.find((s) => secretKey(s) === row.key)
      if (slot) secrets.add(slot)
    }
  }
  return { config: mergeConfig(stored), secrets }
}

const upsert = (env: Env, key: string, value: string) =>
  run(
    env.DB,
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key,
    value,
    Date.now(),
  )

export async function saveConfig(env: Env, config: InstanceConfig): Promise<void> {
  await upsert(env, CONFIG_KEY, JSON.stringify(config))
}

export async function setSecret(env: Env, slot: SecretSlot, value: string | null): Promise<void> {
  if (value === null) await run(env.DB, 'DELETE FROM settings WHERE key = ?', secretKey(slot))
  else await upsert(env, secretKey(slot), await encryptSecret(env, slot, value))
}

export async function getSecret(env: Env, slot: SecretSlot): Promise<string | null> {
  const row = await first<{ value: string }>(env.DB, 'SELECT value FROM settings WHERE key = ?', secretKey(slot))
  return row ? decryptSecret(env, slot, row.value) : null
}

export const appName = (env: Env, inst: Instance): string => inst.config.appName ?? env.APP_NAME ?? 'Print Better'

/** Outbound mail works only when a provider, a sender, and its credential are all present. */
export function outboundEnabled(env: Env, inst: Instance): boolean {
  const { provider, from } = inst.config.email
  if (!from) return false
  if (provider === 'resend') return inst.secrets.has('email.apiKey')
  if (provider === 'cloudflare') return env.EMAIL !== undefined
  return false
}

export async function setupRequired(env: Env): Promise<boolean> {
  return (await first(env.DB, 'SELECT 1 AS one FROM users LIMIT 1')) === null
}
