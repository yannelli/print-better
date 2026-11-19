// Raspberry Pi OS first-boot files (cloud-init NoCloud), shaped like Raspberry Pi Imager 2.x output.
// Built entirely in the browser so Wi-Fi and login secrets never reach the server.
import type { Enrollment } from '@shared/types'

export interface PiConfig {
  hostname: string
  wifi: { ssid: string; password: string; country: string; hidden: boolean } | null
  username: string
  password: string
  sshKey: string
  timezone: string
}

export interface PiFiles {
  userData: string
  networkConfig: string
  metaData: string
}

/** JSON strings are valid YAML double-quoted scalars, which makes any value safe to embed. */
const yamlString = (value: string) => JSON.stringify(value)

export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/
export const SSH_KEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+)\s+\S+/

export function wifiPasswordProblem(password: string): string | null {
  if (!password) return null
  if (/^[0-9a-fA-F]{64}$/.test(password)) return null
  if (password.length < 8 || password.length > 63) return 'Wi-Fi passwords are 8 to 63 characters long.'
  return null
}

/** Download then run, so a failed download fails the step (`curl | sh` would exit 0 on empty input). */
function installStep(enrollment: Enrollment, hostname: string) {
  const server = enrollment.server.replace(/\/+$/, '')
  const script = '/tmp/printbetter-install.sh'
  return `curl -fsSL '${server}/install.sh' -o ${script} && sh ${script} --token '${enrollment.token}' --system --no-tray --name '${hostname}'`
}

function userData(cfg: PiConfig, enrollment: Enrollment): string {
  // The network may come up after runcmd starts, so keep retrying for about ten minutes.
  const retry = `n=0; until ${installStep(enrollment, cfg.hostname)}; do n=$((n+1)); [ $n -ge 40 ] && exit 1; sleep 15; done`
  const lines = [
    '#cloud-config',
    'manage_resolv_conf: false',
    `hostname: ${yamlString(cfg.hostname)}`,
    'manage_etc_hosts: true',
    `timezone: ${yamlString(cfg.timezone)}`,
    'user:',
    `  name: ${yamlString(cfg.username)}`,
    '  shell: /bin/bash',
    '  lock_passwd: false',
  ]
  if (cfg.password) lines.push(`  plain_text_passwd: ${yamlString(cfg.password)}`)
  if (cfg.sshKey.trim()) lines.push('  ssh_authorized_keys:', `    - ${yamlString(cfg.sshKey.trim())}`)
  lines.push(
    `  sudo: ${yamlString('ALL=(ALL) NOPASSWD:ALL')}`,
    `ssh_pwauth: ${cfg.password ? 'true' : 'false'}`,
    'runcmd:',
    '  - [ systemctl, enable, --now, ssh ]',
    `  - [ sh, -c, ${yamlString(retry)} ]`,
  )
  return `${lines.join('\n')}\n`
}

function networkConfig(cfg: PiConfig): string {
  const lines = [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    eth0:',
    '      dhcp4: true',
    '      dhcp6: true',
    '      optional: true',
  ]
  if (cfg.wifi) {
    const { ssid, password, country, hidden } = cfg.wifi
    lines.push(
      '  wifis:',
      '    wlan0:',
      '      dhcp4: true',
      `      regulatory-domain: ${yamlString(country)}`,
      '      access-points:',
      `        ${yamlString(ssid)}:`,
    )
    if (password) lines.push(`          password: ${yamlString(password)}`)
    else lines.push('          auth:', '            key-management: none')
    if (hidden) lines.push('          hidden: true')
    lines.push('      optional: true')
  }
  return `${lines.join('\n')}\n`
}

/** getRandomValues works on plain-http LAN addresses, where crypto.randomUUID is unavailable. */
function instanceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return `printbetter-${Date.now()}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function buildPiFiles(cfg: PiConfig, enrollment: Enrollment): PiFiles {
  return {
    userData: userData(cfg, enrollment),
    networkConfig: networkConfig(cfg),
    metaData: `instance-id: ${instanceId()}\n`,
  }
}

/** Saves a text file under an exact name; octet-stream stops browsers from adding ".txt". */
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
