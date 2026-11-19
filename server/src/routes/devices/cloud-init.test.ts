import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { Enrollment } from '@shared/types'
import { buildPiFiles, HOSTNAME_RE, type PiConfig, SSH_KEY_RE, USERNAME_RE, wifiPasswordProblem } from './cloud-init'

const enrollment: Enrollment = {
  token: 'pbe_AbC123-_xyz',
  expiresAt: 0,
  server: 'https://print.example.com/',
  commands: { unix: '', windows: '' },
}

const base: PiConfig = {
  hostname: 'printbridge',
  wifi: { ssid: 'Home', password: 'correct horse', country: 'US', hidden: false },
  username: 'printbetter',
  password: 'hunter2!',
  sshKey: '',
  timezone: 'America/New_York',
}

const TRICKY = [`My "Home": #1 Wi-Fi`, `it's: a # test`, 'Café ☕ 网络', '- [not, a, list]', '  spaced  ', 'tab\there', 'back\\slash']

function userData(cfg: Partial<PiConfig> = {}) {
  const text = buildPiFiles({ ...base, ...cfg }, enrollment).userData
  expect(text.startsWith('#cloud-config\n')).toBe(true)
  return parse(text)
}

const network = (cfg: Partial<PiConfig> = {}) => parse(buildPiFiles({ ...base, ...cfg }, enrollment).networkConfig).network

describe('network-config', () => {
  it.each(TRICKY)('keeps the SSID and password exactly: %j', (value) => {
    const wlan = network({ wifi: { ssid: value, password: `${value}-pw`, country: 'GB', hidden: false } }).wifis.wlan0
    expect(Object.keys(wlan['access-points'])).toEqual([value])
    expect(wlan['access-points'][value]).toEqual({ password: `${value}-pw` })
    expect(wlan['regulatory-domain']).toBe('GB')
    expect(wlan.dhcp4).toBe(true)
    expect(wlan.optional).toBe(true)
  })

  it('describes an open network with key-management none and marks hidden networks', () => {
    const ap = network({ wifi: { ssid: 'Cafe', password: '', country: 'US', hidden: true } }).wifis.wlan0['access-points'].Cafe
    expect(ap).toEqual({ auth: { 'key-management': 'none' }, hidden: true })
  })

  it('always offers optional ethernet and skips Wi-Fi when cabled', () => {
    const net = network({ wifi: null })
    expect(net.version).toBe(2)
    expect(net.ethernets.eth0).toEqual({ dhcp4: true, dhcp6: true, optional: true })
    expect(net.wifis).toBeUndefined()
  })
})

describe('user-data', () => {
  it.each(TRICKY)('quotes tricky login passwords: %j', (value) => {
    expect(userData({ password: value }).user.plain_text_passwd).toBe(value)
  })

  it('sets the host, user and timezone the way Raspberry Pi Imager does', () => {
    const doc = userData()
    expect(doc.hostname).toBe('printbridge')
    expect(doc.manage_etc_hosts).toBe(true)
    expect(doc.timezone).toBe('America/New_York')
    expect(doc.user).toMatchObject({ name: 'printbetter', shell: '/bin/bash', lock_passwd: false, sudo: 'ALL=(ALL) NOPASSWD:ALL' })
    expect(doc.ssh_pwauth).toBe(true)
    expect(doc.runcmd[0]).toEqual(['systemctl', 'enable', '--now', 'ssh'])
  })

  it('uses only the SSH key when no password is given', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx me@laptop'
    const doc = userData({ password: '', sshKey: `  ${key}\n` })
    expect(doc.user.plain_text_passwd).toBeUndefined()
    expect(doc.user.ssh_authorized_keys).toEqual([key])
    expect(doc.ssh_pwauth).toBe(false)
  })

  it('downloads the installer to a file before running it, with the token and name', () => {
    const [cmd, flag, script] = userData().runcmd[1]
    expect([cmd, flag]).toEqual(['sh', '-c'])
    expect(script).toContain("curl -fsSL 'https://print.example.com/install.sh' -o /tmp/printbetter-install.sh")
    expect(script).toContain("&& sh /tmp/printbetter-install.sh --token 'pbe_AbC123-_xyz' --system --no-tray --name 'printbridge'")
    expect(script).not.toContain('| sh')
  })
})

/** Runs the generated retry loop with curl, sleep and the installer replaced by shell functions. */
function runLoop(curlSucceedsOn: number | null, installExit = 0) {
  const script: string = userData().runcmd[1][2]
  const fakes = [
    'c=0',
    `curl() { c=$((c+1)); echo "curl $c"; ${curlSucceedsOn === null ? 'return 1' : `[ "$c" -ge ${curlSucceedsOn} ]`}; }`,
    'sleep() { :; }',
    `sh() { echo "install $*"; return ${installExit}; }`,
  ].join('\n')
  const out = spawnSync('/bin/sh', ['-c', `${fakes}\n${script}`], { encoding: 'utf8' })
  const lines = out.stdout.trim().split('\n')
  return { status: out.status, curls: lines.filter((l) => l.startsWith('curl')).length, installs: lines.filter((l) => l.startsWith('install')) }
}

describe('first-boot retry loop', () => {
  it('waits for the network, then installs once', () => {
    const run = runLoop(3)
    expect(run.status).toBe(0)
    expect(run.curls).toBe(3)
    expect(run.installs).toEqual(['install /tmp/printbetter-install.sh --token pbe_AbC123-_xyz --system --no-tray --name printbridge'])
  })

  it('gives up with an error after 40 tries without network', () => {
    const run = runLoop(null)
    expect(run.status).toBe(1)
    expect(run.curls).toBe(40)
    expect(run.installs).toEqual([])
  })

  it('retries the install too when it fails', () => {
    const run = runLoop(1, 1)
    expect(run.status).toBe(1)
    expect(run.installs).toHaveLength(40)
  })
})

describe('meta-data', () => {
  it('gets a fresh instance-id every time, even within the same millisecond', () => {
    const ids = Array.from({ length: 20 }, () => parse(buildPiFiles(base, enrollment).metaData)['instance-id'])
    expect(new Set(ids).size).toBe(20)
    expect(ids[0]).toMatch(/^printbetter-\d+-[0-9a-f]{8}$/)
  })
})

describe('input rules', () => {
  it.each(['printbridge', 'a', 'pi-4', 'x'.repeat(63)])('accepts hostname %s', (h) => expect(HOSTNAME_RE.test(h)).toBe(true))
  it.each(['', '-pi', 'pi-', 'Pi', 'pi_4', 'pi.local', 'x'.repeat(64)])('rejects hostname %j', (h) => expect(HOSTNAME_RE.test(h)).toBe(false))
  it.each(['pi', '_svc', 'print-better'])('accepts login %s', (u) => expect(USERNAME_RE.test(u)).toBe(true))
  it.each(['Pi', '1pi', 'a b', 'x'.repeat(33)])('rejects login %j', (u) => expect(USERNAME_RE.test(u)).toBe(false))
  it('recognises SSH public keys', () => {
    expect(SSH_KEY_RE.test('ssh-ed25519 AAAA me')).toBe(true)
    expect(SSH_KEY_RE.test('ecdsa-sha2-nistp256 AAAA')).toBe(true)
    expect(SSH_KEY_RE.test('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(false)
  })
  it('checks Wi-Fi password length, allowing raw 64-hex keys and open networks', () => {
    expect(wifiPasswordProblem('')).toBeNull()
    expect(wifiPasswordProblem('12345678')).toBeNull()
    expect(wifiPasswordProblem('f'.repeat(64))).toBeNull()
    expect(wifiPasswordProblem('short')).toMatch(/8 to 63/)
    expect(wifiPasswordProblem('g'.repeat(64))).toMatch(/8 to 63/)
  })
})
