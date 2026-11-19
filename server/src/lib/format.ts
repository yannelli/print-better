const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const diff = ms - now
  if (Math.abs(diff) < 45_000) return 'just now'
  for (const [unit, size] of STEPS) {
    if (Math.abs(diff) >= size || unit === 'minute') return rtf.format(Math.round(diff / size), unit)
  }
  return 'just now'
}

export const dateTime = (ms: number) => dateTimeFmt.format(ms)
export const date = (ms: number) => dateFmt.format(ms)

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const PAPER: Record<string, string> = {
  na_letter: 'Letter',
  na_legal: 'Legal',
  na_ledger: 'Tabloid',
  na_executive: 'Executive',
  'na_index-4x6': '4 × 6 in photo',
  'na_5x7': '5 × 7 in photo',
  'na_govt-letter': 'Government letter',
  'na_number-10': '#10 envelope',
  na_invoice: 'Statement',
  iso_a3: 'A3',
  iso_a4: 'A4',
  iso_a5: 'A5',
  iso_a6: 'A6',
  iso_b5: 'B5',
  iso_dl: 'DL envelope',
  iso_c5: 'C5 envelope',
  jis_b5: 'JIS B5',
  'om_small-photo': 'Small photo',
}

/** Turns PWG media names like `na_letter_8.5x11in` into "Letter (8.5 × 11 in)". */
export function paperName(media: string): string {
  const match = /^([a-z]+_[^_]+)_(.+?)(in|mm)$/.exec(media)
  if (!match) return media
  const [, key, dims, unit] = match
  const size = `${dims.replace('x', ' × ')} ${unit}`
  const name = PAPER[key]
  if (name) return name.includes('×') ? name : `${name} (${size})`
  const label = key.split('_')[1].replace(/-/g, ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} (${size})`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
