import { beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter } from './helpers/device'
import { CF_PASS, deliver, emailWorld, expectOk, INBOUND_DOMAIN, newEmailJobs, PDF, setPrinterEmail, setUserEmail, type EmailWorld } from './helpers/mail'
import { addMember, type Person } from './helpers/world'

const OFFICE = `office@${INBOUND_DOMAIN}`
const NOT_ALLOWED = 'This sender is not allowed to print here'
const NO_PRINTER = 'No printer accepts email at this address'
const pdf = [{ contentType: 'application/pdf', fileName: 'report.pdf', data: PDF }]

let w: EmailWorld
let member: Person

beforeAll(async () => {
  w = await emailWorld()
  member = await addMember(w.owner)
  await setUserEmail(member.user.id, 'member@home.example')
})

/** Delivers a one-PDF message and returns the rejection reason plus the jobs it created. */
async function send(from: string, to = OFFICE, auth?: string[]) {
  let reason: string | null = null
  const jobs = await newEmailJobs(async () => {
    reason = await deliver({ from, to, auth, text: 'see attached', parts: pdf })
  })
  return { reason: reason as string | null, jobs }
}

const patchWorkspaceEmail = async (emailToPrint: Record<string, unknown>) =>
  expectOk(await w.owner.agent.patch(`/api/workspaces/${w.owner.workspaceId}`, { settings: { emailToPrint } }), 'workspace email')

describe('email-to-print: senders', () => {
  it('prints for a member with a verified address, attributing the job to them', async () => {
    const { reason, jobs } = await send('Member <member@home.example>')
    expect(reason).toBeNull()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ printer_id: w.station.printerId, user_id: member.user.id, title: 'report.pdf', status: 'queued' })
  })

  it('rejects senders that are neither verified members nor allowlisted', async () => {
    expect(await send('stranger@evil.example')).toEqual({ reason: NOT_ALLOWED, jobs: [] })
  })

  it('rejects a member whose address is not verified', async () => {
    const unverified = await addMember(w.owner)
    await setUserEmail(unverified.user.id, 'unverified@home.example', false)
    expect((await send('unverified@home.example')).reason).toBe(NOT_ALLOWED)
  })

  it('matches allowlisted addresses case-insensitively, without a user', async () => {
    const { reason, jobs } = await send('BOSS@corp.EXAMPLE')
    expect(reason).toBeNull()
    expect(jobs[0].user_id).toBeNull()
  })

  it('allows a whole @domain but not lookalike or sub domains', async () => {
    expect((await send('anyone@partner.example')).reason).toBeNull()
    expect((await send('x@evilpartner.example')).reason).toBe(NOT_ALLOWED)
    expect((await send('x@sub.partner.example')).reason).toBe(NOT_ALLOWED)
  })

  it('stops accepting members when allowMembers is off, but keeps the allowlist', async () => {
    await patchWorkspaceEmail({ allowMembers: false })
    try {
      expect((await send('member@home.example')).reason).toBe(NOT_ALLOWED)
      expect((await send('anyone@partner.example')).reason).toBeNull()
    } finally {
      await patchWorkspaceEmail({ allowMembers: true })
    }
  })

  it('authorizes the header From, not the envelope sender', async () => {
    let reason: string | null = null
    const jobs = await newEmailJobs(async () => {
      reason = await deliver({ from: 'stranger@evil.example', to: OFFICE, text: 'hi', parts: pdf }, 'member@home.example')
    })
    expect(reason).toBe(NOT_ALLOWED)
    expect(jobs).toEqual([])
  })
})

describe('email-to-print: DMARC', () => {
  it('rejects mail whose DMARC verdict from Cloudflare is not pass', async () => {
    const auth = ['mx.cloudflare.net; dkim=none; spf=softfail; dmarc=fail header.from=home.example']
    expect(await send('member@home.example', OFFICE, auth)).toEqual({ reason: 'The sender could not be verified (DMARC)', jobs: [] })
  })

  it('trusts only the topmost Authentication-Results, and only from mx.cloudflare.net', async () => {
    const forgedFirst = await send('member@home.example', OFFICE, ['mx.attacker.example; dmarc=pass', CF_PASS])
    expect(forgedFirst.reason).toBe('The sender could not be verified (DMARC)')
    const forgedLater = await send('member@home.example', OFFICE, [CF_PASS, 'mx.cloudflare.net; dmarc=fail'])
    expect(forgedLater.reason).toBeNull()
  })

  it('accepts mail without any Authentication-Results header', async () => {
    expect((await send('member@home.example', OFFICE, [])).reason).toBeNull()
  })
})

describe('email-to-print: recipients and switches', () => {
  it('routes by alias case-insensitively to the matching printer', async () => {
    const garage = await connectPrinter(w.owner, 'usb:04f9:0042:GARAGE')
    garage.device.close()
    await setPrinterEmail(w.owner, garage.printerId, { enabled: true, alias: 'garage' })
    const toGarage = await send('member@home.example', `GARAGE@Print.Example.com`)
    expect(toGarage.jobs.map((j) => j.printer_id)).toEqual([garage.printerId])
    const toOffice = await send('member@home.example', `Office@PRINT.example.COM`)
    expect(toOffice.jobs.map((j) => j.printer_id)).toEqual([w.station.printerId])
  })

  it('rejects unknown aliases and other domains', async () => {
    expect(await send('member@home.example', `nobody@${INBOUND_DOMAIN}`)).toEqual({ reason: NO_PRINTER, jobs: [] })
    expect(await send('member@home.example', 'office@other.example')).toEqual({ reason: NO_PRINTER, jobs: [] })
  })

  it('rejects mail for a printer whose email is off or that is not added', async () => {
    const printerPath = `/api/workspaces/${w.owner.workspaceId}/printers/${w.station.printerId}`
    await setPrinterEmail(w.owner, w.station.printerId, { enabled: false })
    expect((await send('member@home.example')).reason).toBe(NO_PRINTER)
    await setPrinterEmail(w.owner, w.station.printerId, { enabled: true })
    expectOk(await w.owner.agent.patch(printerPath, { added: false }), 'remove printer')
    expect((await send('member@home.example')).reason).toBe(NO_PRINTER)
    expectOk(await w.owner.agent.patch(printerPath, { added: true }), 'add printer')
    expect((await send('member@home.example')).reason).toBeNull()
  })

  it('rejects everything while the workspace has email-to-print off', async () => {
    await patchWorkspaceEmail({ enabled: false })
    try {
      expect((await send('member@home.example')).reason).toBe(NO_PRINTER)
    } finally {
      await patchWorkspaceEmail({ enabled: true })
    }
  })

  it('rejects everything while the server does not receive mail through Cloudflare', async () => {
    const setInbound = async (inbound: string) => expectOk(await w.owner.agent.patch('/api/admin/settings', { email: { inbound } }), 'inbound')
    await setInbound('none')
    try {
      expect(await send('member@home.example')).toEqual({ reason: 'Email-to-print is not enabled on this server', jobs: [] })
    } finally {
      await setInbound('cloudflare')
    }
  })
})
