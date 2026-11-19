import type { DocType, JobOptions } from '../../../shared/printing'
import { countPages, type TextPaper } from '../../../shared/pages'
import type { ByteSource } from '../../../shared/usage'
import type { JobViewRow } from '../../db/rows'
import { memberRole } from '../../services/access'
import type { Ctx } from '../../services/context'
import { accessFor } from '../../services/permissions'
import type { Sender } from './check'
import { effectiveOptions, type PrinterFacts } from './estimate'

/** The sender of a stored job: its member, else the device it came from, else Everyone (email). */
export async function senderOf(ctx: Ctx, job: Pick<JobViewRow, 'workspace_id' | 'user_id' | 'source_client_id'>): Promise<Sender> {
  const ws = job.workspace_id
  const role = job.user_id ? await memberRole(ctx.env.DB, ws, job.user_id) : null
  if (job.user_id && role) return { userId: job.user_id, role, clientId: null, access: await accessFor(ctx, ws, { kind: 'member', userId: job.user_id, role }) }
  if (job.source_client_id) {
    return { userId: null, role: null, clientId: job.source_client_id, access: await accessFor(ctx, ws, { kind: 'device', clientId: job.source_client_id }) }
  }
  return { userId: job.user_id, role: null, clientId: null, access: await accessFor(ctx, ws, { kind: 'everyone' }) }
}

/** Paper for laying out text: the job's media, else the printer's default, else US Letter. */
export function textPaper(printer: PrinterFacts, options: JobOptions): TextPaper {
  const o = effectiveOptions(printer, options)
  return { media: o.media ?? printer.capabilities.mediaDefault, landscape: o.orientation === 'landscape' }
}

/** Range reads of a stored document, so counting a PDF reads only the parts it needs. */
export function storedSource(env: Env, key: string, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      const object = await env.FILES.get(key, { range: { offset, length } })
      if (!object) throw new Error('The document is no longer stored')
      return new Uint8Array(await object.arrayBuffer())
    },
  }
}

export const countStored = (env: Env, key: string, size: number, contentType: DocType, paper: TextPaper): Promise<number | null> =>
  countPages(storedSource(env, key, size), contentType, paper)
