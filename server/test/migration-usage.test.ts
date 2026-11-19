import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { newGroup, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter } from './helpers/device'
import { freshWorkspace, PDF, textJob, uploadJob } from './helpers/jobs'
import { addMember, setupOwner, type Owner } from './helpers/world'

// Storage is per test file, so rebuilding `jobs` here cannot disturb other files.
let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const PRE_0007 =
  'id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options, status, status_message, pages, attempts, created_at, updated_at, completed_at, source_client_id, requested_by'
const JOB_KEYS = [
  'attempts', 'completedAt', 'contentType', 'createdAt', 'fileName', 'hasFile', 'id', 'options', 'pages', 'printerId', 'printerName',
  'requestedBy', 'size', 'source', 'sourceClientId', 'sourceClientName', 'status', 'statusMessage', 'title', 'updatedAt', 'userId', 'workspaceId',
]
const TABLES = [
  'usage_settings', 'printer_prices', 'usage_entries', 'print_rules', 'print_limits', 'limit_adjustments',
  'cost_centers', 'cost_center_defaults', 'budgets', 'printer_controls', 'report_schedules', 'usage_alerts',
]

const migration = (prefix: string) => {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))
  if (!found) throw new Error(`migration ${prefix} missing`)
  return found.queries
}

const sql = (query: string, ...args: unknown[]) => env.DB.prepare(query).bind(...args)
const runAll = (queries: string[]) => env.DB.batch(queries.map((q) => env.DB.prepare(q)))
const jobsSchema = (q: string) => /^\s*CREATE (TABLE|INDEX) jobs/.test(q.replace(/^(\s*--.*\n)*/, ''))
const indexes = async () =>
  (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map(
    (r) => r.name,
  )

describe('0007_held_jobs', () => {
  it('rebuilds a 0003 jobs table keeping every row and index, and accepts held', async () => {
    const station = await connectPrinter(owner)
    const text = await textJob(owner.agent, owner.workspaceId, station.printerId)
    await uploadJob(owner.agent, owner.workspaceId, station.printerId, PDF)
    await sql("UPDATE jobs SET status = 'completed', pages = 2, completed_at = 5 WHERE id = ?", text.id).run()
    const before = (await env.DB.prepare(`SELECT ${PRE_0007} FROM jobs ORDER BY id`).all()).results
    expect(before).toHaveLength(2)

    await runAll(['DROP TABLE jobs', ...migration('0001').filter(jobsSchema), ...migration('0003')])
    for (const row of before) {
      const values = Object.values(row)
      await sql(`INSERT INTO jobs (${PRE_0007}) VALUES (${values.map(() => '?').join(', ')})`, ...values).run()
    }
    await expect(sql("UPDATE jobs SET status = 'held' WHERE id = ?", text.id).run()).rejects.toThrow(/CHECK/)

    await runAll(migration('0007'))

    expect((await env.DB.prepare(`SELECT ${PRE_0007} FROM jobs ORDER BY id`).all()).results).toEqual(before)
    const added = (await env.DB.prepare('SELECT policy, held, usage, cost_center_id FROM jobs').all()).results
    expect(added).toEqual(before.map(() => ({ policy: null, held: null, usage: null, cost_center_id: null })))
    expect(await indexes()).toEqual(['jobs_cost_center', 'jobs_printer_status', 'jobs_source_client', 'jobs_status_completed', 'jobs_workspace_created'])
    await sql("UPDATE jobs SET status = 'held', held = ? WHERE id = ?", JSON.stringify({ kind: 'release', until: 1 }), text.id).run()
    await expect(sql("UPDATE jobs SET status = 'paused' WHERE id = ?", text.id).run()).rejects.toThrow(/CHECK/)
    station.device.close()
  })

  it('leaves Job JSON as it was while nothing sets the new fields', async () => {
    const ws = await freshWorkspace(owner, 'Same JSON')
    const station = await connectPrinter(owner, 'usb:json', ws)
    const job = await textJob(owner.agent, ws, station.printerId)
    expect(Object.keys(job).sort()).toEqual(JOB_KEYS)
    const listed = (await owner.agent.get(wsPath(ws, '/jobs'))).body.items
    expect(Object.keys(listed[0]).sort()).toEqual(JOB_KEYS)
    station.device.close()
  })
})

interface World {
  ws: string
  printerId: string
  clientId: string
  userId: string
  groupId: string
  close(): void
}

async function world(name: string, key: string): Promise<World> {
  const ws = await freshWorkspace(owner, name)
  const station = await connectPrinter(owner, key, ws)
  const member = await addMember(owner, 'member', ws)
  await turnOnAccess(owner, ws)
  const groupId = await newGroup(owner.agent, ws, 'Front desk', [{ type: 'user', id: member.user.id }])
  return { ws, printerId: station.printerId, clientId: station.clientId, userId: member.user.id, groupId, close: () => station.device.close() }
}

/** One row in every new table, each tied to the subject it is about. */
async function seed(w: World): Promise<void> {
  const now = Date.now()
  const id = (name: string) => `${w.ws}-${name}`
  const cycle = JSON.stringify({ kind: 'month', startDay: 1 })
  const limit = (scope: string, column: string, value: string) =>
    sql(
      `INSERT INTO print_limits (id, workspace_id, name, scope, ${column}, unit, amount, cycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pages', 500, ?, ?, ?)`,
      id(`limit-${scope}`),
      w.ws,
      `${scope} pages`,
      scope,
      value,
      cycle,
      now,
      now,
    )
  const ccDefault = (type: string, column: string, value: string) =>
    sql(`INSERT INTO cost_center_defaults (workspace_id, subject_type, ${column}, cost_center_id, updated_at) VALUES (?, ?, ?, ?, ?)`, w.ws, type, value, id('cc'), now)
  await env.DB.batch([
    sql(
      'INSERT INTO usage_settings (workspace_id, currency, time_zone, bw_page_micros, color_page_micros, duplex_sheet_discount_micros, updated_at) VALUES (?, ?, ?, 20000, 90000, 5000, ?)',
      w.ws,
      'EUR',
      'Europe/Berlin',
      now,
    ),
    sql('INSERT INTO printer_prices (printer_id, workspace_id, bw_page_micros, color_page_micros, duplex_sheet_discount_micros, updated_at) VALUES (?, ?, 10000, 50000, 0, ?)', w.printerId, w.ws, now),
    sql(
      `INSERT INTO usage_entries (workspace_id, job_id, attempt, at, source, user_id, client_id, printer_id, cost_center_id, jobs, pages, sheets, color_pages, cost_micros)
       VALUES (?, ?, 1, ?, 'device', ?, ?, ?, ?, 1, 2, 1, 0, 40000)`,
      w.ws,
      id('job'),
      now,
      w.userId,
      w.clientId,
      w.printerId,
      id('cc'),
    ),
    sql("INSERT INTO print_rules (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Big jobs on both sides', 1, ?, ?)", id('rule'), w.ws, now, now),
    limit('member', 'user_id', w.userId),
    limit('group', 'group_id', w.groupId),
    limit('device', 'client_id', w.clientId),
    limit('printer', 'printer_id', w.printerId),
    sql('INSERT INTO limit_adjustments (id, workspace_id, limit_id, cycle_start, user_id, amount, created_at) VALUES (?, ?, ?, ?, ?, 100, ?)', id('extra'), w.ws, id('limit-member'), now, w.userId, now),
    sql("INSERT INTO cost_centers (id, workspace_id, name, code, created_at, updated_at) VALUES (?, ?, 'Marketing', 'MKT', ?, ?)", id('cc'), w.ws, now, now),
    ccDefault('user', 'user_id', w.userId),
    ccDefault('group', 'group_id', w.groupId),
    ccDefault('client', 'client_id', w.clientId),
    sql("INSERT INTO budgets (id, workspace_id, cost_center_id, unit, amount, cycle, created_at, updated_at) VALUES (?, ?, ?, 'cost', 50000000, ?, ?, ?)", id('budget'), w.ws, id('cc'), cycle, now, now),
    sql('INSERT INTO printer_controls (printer_id, workspace_id, approval, secure_release, updated_at) VALUES (?, ?, 1, 1, ?)', w.printerId, w.ws, now),
    sql(
      "INSERT INTO report_schedules (id, workspace_id, name, dimension, cycle, origin, next_run_at, created_at) VALUES (?, ?, 'Monthly', 'cost-center', ?, 'https://print.example.com', ?, ?)",
      id('report'),
      w.ws,
      cycle,
      now,
      now,
    ),
    sql('INSERT INTO usage_alerts (workspace_id, limit_id, subject, cycle_start, threshold, sent_at) VALUES (?, ?, ?, ?, 80, ?)', w.ws, id('limit-member'), `user:${w.userId}`, now, now),
    sql('INSERT INTO usage_alerts (workspace_id, budget_id, cycle_start, threshold, sent_at) VALUES (?, ?, ?, 100, ?)', w.ws, id('budget'), now, now),
  ])
}

async function counts(ws: string): Promise<Record<string, number>> {
  const rows = await env.DB.batch(TABLES.map((t) => sql(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`, ws)))
  return Object.fromEntries(TABLES.map((t, i) => [t, (rows[i].results[0] as { n: number }).n]))
}

describe('usage, print policy and enterprise tables', () => {
  it('empty with their workspace', async () => {
    const w = await world('Cascade', 'usb:cascade')
    await seed(w)
    expect(Object.values(await counts(w.ws)).every((n) => n > 0)).toBe(true)
    w.close()
    expect((await owner.agent.del(wsPath(w.ws))).status).toBe(204)
    expect(Object.values(await counts(w.ws)).every((n) => n === 0)).toBe(true)
  })

  it('keep usage when its printer, device or member goes, and drop what was about them', async () => {
    const w = await world('Subjects', 'usb:subjects')
    await seed(w)
    expect((await owner.agent.del(wsPath(w.ws, `/printers/${w.printerId}`))).status).toBe(204)
    w.close()
    expect((await owner.agent.del(wsPath(w.ws, `/clients/${w.clientId}`))).status).toBe(204)
    expect((await owner.agent.del(wsPath(w.ws, `/members/${w.userId}`))).status).toBe(204)

    expect(await sql('SELECT user_id, client_id, printer_id, pages FROM usage_entries WHERE workspace_id = ?', w.ws).first()).toEqual({
      user_id: w.userId,
      client_id: null,
      printer_id: null,
      pages: 2,
    })
    const limits = await sql('SELECT scope FROM print_limits WHERE workspace_id = ?', w.ws).all<{ scope: string }>()
    expect(limits.results.map((l) => l.scope)).toEqual(['group'])
    const defaults = await sql('SELECT subject_type FROM cost_center_defaults WHERE workspace_id = ?', w.ws).all<{ subject_type: string }>()
    expect(defaults.results.map((d) => d.subject_type)).toEqual(['group'])
    expect(await counts(w.ws)).toMatchObject({ printer_prices: 0, printer_controls: 0, limit_adjustments: 0, usage_alerts: 1, budgets: 1 })
  })
})
