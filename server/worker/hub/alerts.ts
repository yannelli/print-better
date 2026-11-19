import type { PrinterStatus } from '../../shared/printing'
import type { PrinterViewRow } from '../db/rows'
import { sendMail } from '../email/outbound'
import { printerAlertMail } from '../email/templates'
import { all, first } from '../lib/db'
import { hit } from '../lib/throttle'
import { HOUR } from '../lib/time'
import { appName, loadInstance, outboundEnabled } from '../services/instance-store'

const NEEDS_ATTENTION: Record<string, string> = {
  'media-empty': 'out of paper',
  'media-needed': 'out of paper',
  'media-jam': 'paper jam',
  'toner-empty': 'out of toner',
  'marker-supply-empty': 'out of ink or toner',
  'marker-waste-full': 'waste container full',
  'door-open': 'a door is open',
  'cover-open': 'a cover is open',
  'input-tray-missing': 'a paper tray is missing',
  'output-area-full': 'the output tray is full',
}

export function attentionProblem(status: PrinterStatus): string | null {
  const problems = [...new Set(status.reasons.map((r) => NEEDS_ATTENTION[r]).filter(Boolean))]
  if (problems.length > 0) return problems.join(', ')
  return status.state === 'stopped' ? (status.message ?? 'stopped') : null
}

/** Emails workspace admins about an added printer that needs a person, at most once per printer every 12 hours. */
export async function alertIfNeeded(env: Env, origin: string, printer: PrinterViewRow, status: PrinterStatus): Promise<void> {
  const problem = printer.added === 1 ? attentionProblem(status) : null
  if (!problem) return
  const inst = await loadInstance(env)
  if (!outboundEnabled(env, inst)) return
  if ((await hit(env, `alert:${printer.id}`, 12 * HOUR)) > 1) return
  const [admins, ws] = await Promise.all([
    all<{ email: string }>(
      env.DB,
      `SELECT u.email FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin') AND u.email IS NOT NULL`,
      printer.workspace_id,
    ),
    first<{ name: string }>(env.DB, 'SELECT name FROM workspaces WHERE id = ?', printer.workspace_id),
  ])
  if (admins.length === 0 || !ws) return
  await sendMail(
    env,
    printerAlertMail({ to: admins.map((a) => a.email), app: appName(env, inst), printer: printer.name, workspace: ws.name, problem, url: origin }),
    inst,
  )
}
