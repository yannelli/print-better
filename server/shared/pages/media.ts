export interface Paper {
  /** Portrait width and height in points. */
  width: number
  height: number
}

export const LETTER: Paper = { width: 612, height: 792 }

const MM = 72 / 25.4
const MIN_PT = 36
const MAX_PT = 3400
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/

const ALIASES = new Map([
  ['letter', 'na_letter_8.5x11in'],
  ['legal', 'na_legal_8.5x14in'],
  ['executive', 'na_executive_7.25x10.5in'],
  ['ledger', 'na_ledger_11x17in'],
  ['tabloid', 'na_ledger_11x17in'],
  ['a3', 'iso_a3_297x420mm'],
  ['a4', 'iso_a4_210x297mm'],
  ['a5', 'iso_a5_148x210mm'],
])

/** A PWG self-describing media name ("na_letter_8.5x11in", "iso_a4_210x297mm") or alias, read like the client's `Media::parse`. */
export function parseMedia(name: string): Paper | null {
  const lower = name.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())
  const alias = ALIASES.get(lower.replace(/^(na-)*/, '').replace(/^(iso-)*/, ''))
  if (alias) return parseMedia(alias)
  const dims = lower.slice(lower.lastIndexOf('_') + 1)
  const unit = dims.endsWith('in') ? 72 : dims.endsWith('mm') ? MM : 0
  const sides = dims.slice(0, -2).split('x')
  if (!unit || sides.length !== 2) return null
  const [w, h] = sides.map((side) => (DECIMAL.test(side) ? Number(side) * unit : NaN))
  const valid = (pt: number) => Number.isFinite(pt) && pt >= MIN_PT && pt <= MAX_PT
  return valid(w) && valid(h) ? { width: Math.min(w, h), height: Math.max(w, h) } : null
}
