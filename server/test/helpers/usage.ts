import { env } from 'cloudflare:workers'
import type { ExtensionId } from '../../shared/extensions'
import { ok, wsPath } from './access'
import type { Agent, Body, Reply } from './http'
import { jobsPath } from './jobs'
import { PdfWriter } from './pdf'
import type { Owner } from './world'

/** Makes an extension available on the instance (the setup owner is its admin) and turns it on or off in `ws`. */
export async function switchExtension(owner: Owner, id: ExtensionId, ws: string, on: boolean): Promise<void> {
  if (on) ok(await owner.agent.patch(`/api/admin/extensions/${id}`, { available: true }), 'make available')
  ok(await owner.agent.patch(wsPath(ws, `/extensions/${id}`), { enabled: on }), 'workspace switch')
}

export const turnOnPolicies = (owner: Owner, ws = owner.workspaceId) => switchExtension(owner, 'print-policies', ws, true)

/** A PDF with `pages` pages and a plain cross-reference table, like the ones macOS writes. */
export function pdfOf(pages: number): Uint8Array {
  const w = new PdfWriter()
  const kids = Array.from({ length: pages }, (_, i) => i + 3)
  w.obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  w.obj(2, `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`)
  for (const n of kids) w.obj(n, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>')
  return w.end(w.table(w.plain(0, 1, 2, ...kids), `/Size ${pages + 3} /Root 1 0 R`))
}

const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))

/** `POST /jobs` with an inline PDF of `pages` pages. */
export const pdfJob = (agent: Agent, ws: string, printerId: string, pages: number, options: Body = {}, extra: Body = {}): Promise<Reply> =>
  agent.post(jobsPath(ws), { printerId, base64: base64(pdfOf(pages)), contentType: 'application/pdf', fileName: 'notes.pdf', options, ...extra })

export const preview = (agent: Agent, ws: string, body: Body): Promise<Reply> => agent.post(wsPath(ws, '/jobs/preview'), body)

export interface EntryRow {
  job_id: string
  attempt: number
  at: number
  source: string
  user_id: string | null
  client_id: string | null
  printer_id: string | null
  jobs: number
  pages: number
  sheets: number
  color_pages: number
  cost_micros: number
  estimated: number
  settled_at: number | null
}

export const entriesOf = async (jobId: string): Promise<EntryRow[]> =>
  (await env.DB.prepare('SELECT * FROM usage_entries WHERE job_id = ? ORDER BY attempt').bind(jobId).all<EntryRow>()).results

export const entriesIn = async (ws: string): Promise<EntryRow[]> =>
  (await env.DB.prepare('SELECT * FROM usage_entries WHERE workspace_id = ? ORDER BY id').bind(ws).all<EntryRow>()).results
