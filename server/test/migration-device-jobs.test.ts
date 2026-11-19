import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter } from './helpers/device'
import { PDF, textJob, uploadJob } from './helpers/jobs'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

// Storage is per test file, so rebuilding `jobs` here cannot disturb other files.
let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const OLD_COLUMNS = 'id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options, status, status_message, pages, attempts, created_at, updated_at, completed_at'

const migration = (prefix: string) => {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))
  if (!found) throw new Error(`migration ${prefix} missing`)
  return found.queries
}

const runAll = (queries: string[]) => env.DB.batch(queries.map((q) => env.DB.prepare(q)))
const indexes = async () =>
  (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map(
    (r) => r.name,
  )

describe('0003_device_jobs', () => {
  it('rebuilds a pre-0003 jobs table keeping every row and index', async () => {
    const station = await connectPrinter(owner)
    const text = await textJob(owner.agent, owner.workspaceId, station.printerId)
    const upload = await uploadJob(owner.agent, owner.workspaceId, station.printerId, PDF)
    await env.DB.prepare("UPDATE jobs SET status = 'completed', pages = 3, completed_at = 123 WHERE id = ?").bind(text.id).run()
    const before = (await env.DB.prepare(`SELECT ${OLD_COLUMNS} FROM jobs ORDER BY id`).all()).results
    expect(before).toHaveLength(2)

    const oldSchema = migration('0001').filter((q) => /^\s*CREATE (TABLE|INDEX) jobs/.test(q.replace(/^(\s*--.*\n)*/, '')))
    expect(oldSchema).toHaveLength(4)
    await runAll(['DROP TABLE jobs', ...oldSchema])
    for (const row of before) {
      const values = Object.values(row)
      await env.DB.prepare(`INSERT INTO jobs (${OLD_COLUMNS}) VALUES (${values.map(() => '?').join(', ')})`).bind(...values).run()
    }
    await expect(env.DB.prepare("UPDATE jobs SET source = 'device' WHERE id = ?").bind(text.id).run()).rejects.toThrow(/CHECK/)

    await runAll(migration('0003'))

    expect((await env.DB.prepare(`SELECT ${OLD_COLUMNS} FROM jobs ORDER BY id`).all()).results).toEqual(before)
    expect((await env.DB.prepare('SELECT source_client_id, requested_by FROM jobs').all()).results).toEqual([
      { source_client_id: null, requested_by: null },
      { source_client_id: null, requested_by: null },
    ])
    expect(await indexes()).toEqual(['jobs_printer_status', 'jobs_source_client', 'jobs_status_completed', 'jobs_workspace_created'])
    const listed = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/jobs`)
    expect(listed.body.items.map((j: { id: string }) => j.id).sort()).toEqual([text.id, upload.id].sort())
    expect(listed.body.items[0]).toMatchObject({ sourceClientId: null, sourceClientName: null, requestedBy: null })
    station.device.close()
  })

  it('accepts device jobs and clears source_client_id when the device is removed', async () => {
    const station = await connectPrinter(owner, 'usb:fk')
    const desk = await enrollDevice(owner)
    const job = await textJob(owner.agent, owner.workspaceId, station.printerId)
    await env.DB.prepare("UPDATE jobs SET source = 'device', source_client_id = ?, requested_by = 'sam' WHERE id = ?").bind(desk.clientId, job.id).run()
    await expect(env.DB.prepare("UPDATE jobs SET source = 'fax' WHERE id = ?").bind(job.id).run()).rejects.toThrow(/CHECK/)
    expect((await owner.agent.del(`/api/workspaces/${owner.workspaceId}/clients/${desk.clientId}`)).status).toBe(204)
    expect(await env.DB.prepare('SELECT source, source_client_id, requested_by FROM jobs WHERE id = ?').bind(job.id).first()).toEqual({
      source: 'device',
      source_client_id: null,
      requested_by: 'sam',
    })
    station.device.close()
  })
})
