import { beforeAll, describe, expect, it } from 'vitest'
import { grant, newGroup, setEveryone, turnOnAccess } from './helpers/access'
import { deliver, emailWorld, INBOUND_DOMAIN, newEmailJobs, PDF, setUserEmail, type EmailWorld } from './helpers/mail'
import { addMember, type Person } from './helpers/world'

const OFFICE = `office@${INBOUND_DOMAIN}`
const NOT_ALLOWED = 'This sender is not allowed to print here'
const pdf = [{ contentType: 'application/pdf', fileName: 'report.pdf', data: PDF }]

let w: EmailWorld
let member: Person
let printerId: string

beforeAll(async () => {
  w = await emailWorld()
  printerId = w.station.printerId
  member = await addMember(w.owner)
  await setUserEmail(member.user.id, 'member@home.example')
  await setUserEmail(w.owner.user.id, 'owner@home.example')
  await turnOnAccess(w.owner)
})

async function send(from: string) {
  let reason: string | null = null
  const jobs = await newEmailJobs(async () => {
    reason = await deliver({ from, to: OFFICE, text: 'see attached', parts: pdf })
  })
  return { reason: reason as string | null, printed: jobs.length }
}

const everyone = (role: string | null) => setEveryone(w.owner.agent, w.owner.workspaceId, printerId, role)

describe('email to print with printer access on', () => {
  it('prints for a member only where they may print, as themselves', async () => {
    expect(await send('member@home.example')).toEqual({ reason: null, printed: 1 })
    await everyone('viewer')
    expect(await send('member@home.example')).toEqual({ reason: NOT_ALLOWED, printed: 0 })
    expect(await send('owner@home.example')).toEqual({ reason: null, printed: 1 })
    const groupId = await newGroup(w.owner.agent, w.owner.workspaceId, 'Senders', [{ type: 'user', id: member.user.id }])
    await grant(w.owner.agent, w.owner.workspaceId, printerId, { type: 'group', id: groupId }, 'user')
    expect(await send('member@home.example')).toEqual({ reason: null, printed: 1 })
    await everyone(null)
  })

  it('prints for allowlisted non-members only where Everyone has print', async () => {
    expect((await send('boss@corp.example')).printed).toBe(1)
    await everyone('none')
    await grant(w.owner.agent, w.owner.workspaceId, printerId, { type: 'user', id: member.user.id }, 'manager')
    expect(await send('boss@corp.example')).toEqual({ reason: NOT_ALLOWED, printed: 0 })
    expect((await send('member@home.example')).printed).toBe(1)
    await everyone('user')
    expect((await send('anyone@partner.example')).printed).toBe(1)
    await everyone('none')
    expect((await send('anyone@partner.example')).reason).toBe(NOT_ALLOWED)
    await everyone(null)
  })
})
