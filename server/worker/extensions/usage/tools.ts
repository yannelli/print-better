import type { JobPreview, PriceList, Prices } from '../../../shared/usage'
import { formatAmount, formatMicros } from '../../../shared/usage-text'
import { ACTION, inWorkspace, integer, object, output, pick, READ, text, UPDATE, workspaceOf, type Tool } from '../../mcp/tool'
import { DOC_TYPE, JOB_OPTIONS } from '../../mcp/tools/schemas'
import { getPrices, setPrices } from './prices'
import { previewJob } from './preview'
import { usageSettings } from './settings'
import { MAX_MICROS } from './values'

const micros = (what: string) => integer(`${what}, in micros: millionths of the currency, so 25000 is 0.025`, 0, MAX_MICROS)
const PRICE_LIST = object(
  {
    bwPageMicros: micros('Each black-and-white page'),
    colorPageMicros: micros('Each color page'),
    duplexSheetDiscountMicros: micros('Taken off for each sheet printed on both sides'),
  },
  ['bwPageMicros', 'colorPageMicros', 'duplexSheetDiscountMicros'],
  'A price list',
)
const NEEDS = 'Needs Print rules and limits or Enterprise controls.'

function describePrices(p: Prices): string {
  const list = (l: PriceList) =>
    `${formatMicros(l.bwPageMicros, p.currency, 'en-US')} per black-and-white page, ${formatMicros(l.colorPageMicros, p.currency, 'en-US')} per color page, ` +
    `${formatMicros(l.duplexSheetDiscountMicros, p.currency, 'en-US')} off each two-sided sheet`
  const printers = Object.entries(p.printers).map(([id, l]) => `Printer ${id}: ${list(l)}.`)
  return [`Currency ${p.currency}, time zone ${p.timeZone}.`, `Default: ${list(p.default)}.`, ...printers].join('\n')
}

function describePreview(p: JobPreview, currency: string): string {
  if (p.block) return `This job would be refused: ${p.block}`
  const { pages, sheets, costMicros, documentPages } = p.usage
  const lines = [
    `It would print ${formatAmount('pages', pages, currency, 'en-US')} on ${formatAmount('sheets', sheets, currency, 'en-US')}` +
      `${costMicros > 0 ? `, about ${formatMicros(costMicros, currency, 'en-US')}` : ''}, on printer ${p.printerId}.`,
  ]
  if (documentPages === null) lines.push("The document's pages weren't counted, so each copy counts as 1 page.")
  if (p.hold) lines.push(p.hold === 'approval' ? 'It would wait for approval.' : 'It would wait until you release it at the printer.')
  for (const note of p.notes) lines.push(`${note.name}: ${note.message}`)
  for (const m of p.meters) lines.push(`${m.name}: ${formatAmount(m.unit, m.left, currency, 'en-US')} left of ${formatAmount(m.unit, m.amount, currency, 'en-US')}${m.over ? ', and this job goes over' : ''}.`)
  return lines.join('\n')
}

/** Shared by both usage extensions; listed once while either is available. */
export const usageTools: Tool[] = [
  {
    name: 'get_prices',
    title: 'Get prices',
    description: `The workspace currency, time zone, and page prices, with any printer's own prices. Money is in micros: millionths of the currency. ${NEEDS}`,
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const prices = await getPrices(ctx, await workspaceOf(ctx, args))
      return output(describePrices(prices), { prices })
    },
  },
  {
    name: 'set_prices',
    title: 'Set prices',
    description: `Changes the currency, time zone, default prices, or a printer's own prices. Fields left out stay as they are. Admins and owners only. ${NEEDS}`,
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({
      currency: text('ISO 4217 code, e.g. USD or EUR'),
      timeZone: text('IANA time zone, e.g. America/Chicago; cycles and time conditions use it'),
      default: PRICE_LIST,
      printers: {
        type: 'object',
        description: "Printer ids to their own price list, or to null to use the default again. Other printers keep theirs.",
        additionalProperties: { anyOf: [PRICE_LIST, { type: 'null' }] },
      },
    }),
    run: async (ctx, args) => {
      const prices = await setPrices(ctx, await workspaceOf(ctx, args), pick(args, ['currency', 'timeZone', 'default', 'printers']))
      return output(`Saved.\n${describePrices(prices)}`, { prices })
    },
  },
  {
    name: 'preview_print_job',
    title: 'Preview print job',
    description: `What would happen to a job sent now: refused or accepted, any printer or option changes and notes, pages, sheets, cost, and the limits it counts against. Nothing is printed. ${NEEDS}`,
    scope: 'print',
    annotations: { ...ACTION, readOnlyHint: true, idempotentHint: true },
    inputSchema: inWorkspace(
      {
        printerId: text('Printer id; omit to use the workspace default printer'),
        contentType: DOC_TYPE,
        size: integer('Document size in bytes', 1, Number.MAX_SAFE_INTEGER),
        documentPages: integer('Pages in the document, if known. Used for this preview only: real jobs are always counted again', 1, 100_000),
        options: JOB_OPTIONS,
      },
      ['contentType', 'size'],
    ),
    run: async (ctx, args) => {
      const workspaceId = await workspaceOf(ctx, args)
      // costCenter is accepted only while an extension adds it to this tool (extensions/tools.ts).
      const preview = await previewJob(ctx, workspaceId, pick(args, ['printerId', 'contentType', 'size', 'documentPages', 'options', 'costCenter']))
      return output(describePreview(preview, (await usageSettings(ctx, workspaceId)).currency), { preview })
    },
  },
]
