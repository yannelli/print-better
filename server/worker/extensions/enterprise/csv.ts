/** Digits after the decimal point the currency normally shows: 2 for USD, 0 for JPY. */
const minorDigits = (currency: string): number => new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2

/** Micros as an exact decimal, with at least the currency's usual digits: 12500000 is "12.50", 75000 is "0.075". */
export function decimal(micros: number, currency: string): string {
  const sign = micros < 0 ? '-' : ''
  const abs = Math.abs(micros)
  const whole = Math.floor(abs / 1_000_000)
  const fraction = String(abs % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  const digits = fraction.padEnd(minorDigits(currency), '0')
  return `${sign}${whole}${digits ? `.${digits}` : ''}`
}

export const formatMoney = (micros: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: minorDigits(currency), maximumFractionDigits: 6 }).format(micros / 1_000_000)

/** Text a spreadsheet could run as a formula gets a leading quote; plain numbers, such as a decimal cost, stay as they are. */
const inert = (text: string): string => (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text)

/** RFC 4180: quoted when it holds a comma, quote, or line break; quotes doubled. */
const field = (value: string | number | null): string => {
  const text = value === null ? '' : typeof value === 'number' ? String(value) : inert(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** UTF-8 text with CRLF line ends and a header row. */
export const csv = (header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string =>
  [header, ...rows].map((row) => row.map(field).join(',')).join('\r\n') + '\r\n'

export function csvResponse(text: string, filename: string): Response {
  return new Response(text, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  })
}
