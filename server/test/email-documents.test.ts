import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { deliver, emailWorld, expectOk, INBOUND_DOMAIN, JPEG, newEmailJobs, PDF, PNG, setUserEmail, type EmailWorld, type MailSpec, type Part } from './helpers/mail'
import { addMember } from './helpers/world'

const OFFICE = `office@${INBOUND_DOMAIN}`
const SENDER = 'member@home.example'
const MB = 1024 * 1024

let w: EmailWorld

beforeAll(async () => {
  w = await emailWorld()
  const member = await addMember(w.owner)
  await setUserEmail(member.user.id, SENDER)
})

async function mail(spec: Partial<MailSpec>) {
  let reason: string | null = null
  const jobs = await newEmailJobs(async () => {
    reason = await deliver({ from: SENDER, to: OFFICE, ...spec })
  })
  return { reason: reason as string | null, jobs }
}

async function stored(fileKey: string | null): Promise<Uint8Array> {
  const object = await env.FILES.get(fileKey ?? 'missing')
  if (!object) throw new Error(`no R2 object at ${fileKey}`)
  return new Uint8Array(await object.arrayBuffer())
}

const setMaxUpload = async (maxUploadMb: number) =>
  expectOk(await w.owner.agent.patch(`/api/workspaces/${w.owner.workspaceId}`, { settings: { maxUploadMb } }), 'max upload')

describe('email-to-print: documents', () => {
  it('stores the attachment bytes in R2 with their hash and size', async () => {
    const { jobs } = await mail({ parts: [{ contentType: 'application/pdf', fileName: 'report.pdf', data: PDF }] })
    expect(jobs[0]).toMatchObject({ content_type: 'application/pdf', file_name: 'report.pdf', size: PDF.byteLength })
    expect(await stored(jobs[0].file_key)).toEqual(PDF)
    const job = await env.DB.prepare('SELECT sha256 FROM jobs WHERE id = ?').bind(jobs[0].id).first<{ sha256: string }>()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', PDF))
    expect(job?.sha256).toBe([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''))
  })

  it('prints each supported attachment, in order, and skips the rest', async () => {
    const parts: Part[] = [
      { contentType: 'application/pdf', fileName: 'a.pdf', data: PDF },
      { contentType: 'image/jpeg', fileName: 'b.jpg', data: JPEG },
      { contentType: 'image/png', fileName: 'c.png', data: PNG },
      { contentType: 'text/plain', fileName: 'd.txt', data: 'plain attachment' },
      { contentType: 'application/octet-stream', fileName: 'e.pdf', data: PDF },
      { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'f.docx', data: 'PK..' },
      { contentType: 'image/png', fileName: 'logo.png', data: PNG, inline: true },
    ]
    const { reason, jobs } = await mail({ text: 'Five documents attached', parts })
    expect(reason).toBeNull()
    expect(jobs.map((j) => [j.title, j.content_type])).toEqual([
      ['a.pdf', 'application/pdf'],
      ['b.jpg', 'image/jpeg'],
      ['c.png', 'image/png'],
      ['d.txt', 'text/plain'],
      ['e.pdf', 'application/pdf'],
    ])
    expect(jobs.every((j) => j.status === 'queued' && j.source === 'email')).toBe(true)
  })

  it('caps one message at 10 documents', async () => {
    const parts = Array.from({ length: 12 }, (_, i) => ({ contentType: 'application/pdf', fileName: `page${i}.pdf`, data: PDF }))
    const { jobs } = await mail({ parts })
    expect(jobs.map((j) => j.title)).toEqual(parts.slice(0, 10).map((p) => p.fileName))
  })

  it('prints the trimmed body, titled by the subject, when nothing is attached', async () => {
    const { reason, jobs } = await mail({ subject: 'Grocery list', text: '\n  eggs\n  milk  \n\n' })
    expect(reason).toBeNull()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ title: 'Grocery list', content_type: 'text/plain', file_name: null })
    expect(new TextDecoder().decode(await stored(jobs[0].file_key))).toBe('eggs\n  milk')
  })

  it('prints only the attachments when there is also a body', async () => {
    const { jobs } = await mail({ text: 'Please print the attached', parts: [{ contentType: 'image/png', fileName: 'scan.png', data: PNG }] })
    expect(jobs.map((j) => j.content_type)).toEqual(['image/png'])
  })

  it('rejects a message with nothing printable', async () => {
    expect(await mail({ text: '   ' })).toEqual({ reason: 'The message has nothing printable', jobs: [] })
    const onlyUnsupported = await mail({ parts: [{ contentType: 'application/zip', fileName: 'files.zip', data: 'PK..' }] })
    expect(onlyUnsupported).toEqual({ reason: 'The message has nothing printable', jobs: [] })
  })

  it('skips attachments over the workspace upload limit and truncates a long body to it', async () => {
    await setMaxUpload(1)
    try {
      const big = new Uint8Array(MB + 1).fill(0x41)
      const tooBig = await mail({ parts: [{ contentType: 'application/pdf', fileName: 'huge.pdf', data: big }] })
      expect(tooBig).toEqual({ reason: 'The message has nothing printable', jobs: [] })
      const { jobs } = await mail({ subject: 'Long', text: 'x'.repeat(MB + 5000) })
      expect(jobs[0].size).toBe(MB)
    } finally {
      await setMaxUpload(50)
    }
  })

  it('titles a body-only message "Email" when it has no subject', async () => {
    const { jobs } = await mail({ subject: '', text: 'no subject here' })
    expect(jobs[0].title).toBe('Email')
  })
})
