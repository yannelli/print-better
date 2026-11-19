import { DOC_TYPES } from '../../../shared/printing'
import type { JobPreview } from '../../../shared/usage'
import { MB, type Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { oneOf, optStr } from '../../http/validate'
import { requireScope } from '../../services/access'
import type { Ctx } from '../../services/context'
import { requestSource, resolvePrinter, workspaceLimits } from '../../services/job-create'
import { parseJobOptions } from '../../services/job-options'
import { memberAccess } from '../../services/permissions'
import { requireUsage } from './active'
import { jobDraft, runJobCheck } from './check'
import { wholeNumber } from './values'

const MAX_PAGES = 100_000

/** `POST /jobs/preview`: the job check on the body of `POST /jobs` without the document. Nothing is stored or sent. */
export async function previewJob(ctx: Ctx, workspaceId: string, body: Json): Promise<JobPreview> {
  requireScope(ctx, 'print')
  const { user, role, access } = await memberAccess(ctx, workspaceId)
  await requireUsage(ctx, workspaceId)
  const limits = await workspaceLimits(ctx.env, workspaceId)
  const contentType = oneOf(body, 'contentType', DOC_TYPES)
  const size = wholeNumber(body.size, 'size', 1, Number.MAX_SAFE_INTEGER)
  if (size > limits.maxBytes) throw badRequest(`Documents are limited to ${limits.maxBytes / MB} MB`, 'too_large')
  const documentPages = body.documentPages == null ? null : wholeNumber(body.documentPages, 'documentPages', 1, MAX_PAGES)
  const printer = await resolvePrinter(ctx.env, workspaceId, optStr(body, 'printerId', { max: 64 }) ?? null, limits.defaultPrinterId, access)
  const options = body.options === undefined ? {} : parseJobOptions(body.options)
  const draft = await jobDraft(ctx, {
    workspaceId,
    jobId: '',
    attempt: 1,
    source: requestSource(ctx),
    sender: { userId: user.id, role, clientId: null, access },
    contentType,
    size,
    documentPages,
    counted: true,
    costCenter: body.costCenter,
  })
  const decision = await runJobCheck(ctx, draft, printer, options)
  return {
    block: decision.block,
    printerId: decision.printer.id,
    options: decision.options,
    notes: decision.notes,
    hold: decision.hold?.kind ?? null,
    costCenterId: decision.costCenterId,
    usage: decision.usage,
    meters: decision.meters,
  }
}
