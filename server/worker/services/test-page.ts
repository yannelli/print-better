import { utf8 } from '../lib/encoding'

export interface TestPageInput {
  printerName: string
  deviceName: string
  /** PWG media name; `iso_a4…` selects A4, anything else US Letter. */
  mediaDefault: string | null
  time: Date
}

const fmt = (n: number): string => String(Number(n.toFixed(2)))

/** PDF literal string in WinAnsi: Latin-1 as octal escapes keeps the file pure ASCII so byte offsets equal string offsets. */
function pdfText(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`
    else if (code >= 32 && code < 127) out += ch
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += '?'
  }
  return `(${out})`
}

const text = (font: 'F1' | 'F2', size: number, x: number, y: number, s: string) => `BT /${font} ${size} Tf ${fmt(x)} ${fmt(y)} Td ${pdfText(s)} Tj ET`

/** Four Bezier quarter-arcs approximate a circle (k = 0.5523). */
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r
  const p = (...xs: number[]) => xs.map(fmt).join(' ')
  return [
    `${p(cx + r, cy)} m`,
    `${p(cx + r, cy + k, cx + k, cy + r, cx, cy + r)} c`,
    `${p(cx - k, cy + r, cx - r, cy + k, cx - r, cy)} c`,
    `${p(cx - r, cy - k, cx - k, cy - r, cx, cy - r)} c`,
    `${p(cx + k, cy - r, cx + r, cy - k, cx + r, cy)} c`,
  ].join('\n')
}

function drawing(p: TestPageInput, w: number, h: number, paper: string): string {
  const left = 54
  const top = h - 54
  const stamp = `${p.time.toISOString().replace('T', ' ').slice(0, 19)} UTC`
  const rows: [string, string][] = [
    ['Printer', p.printerName],
    ['Device', p.deviceName],
    ['Printed', stamp],
    ['Paper', paper],
  ]
  const ops = [
    `q 0.75 w 0 G ${fmt(36)} ${fmt(36)} ${fmt(w - 72)} ${fmt(h - 72)} re S Q`,
    text('F2', 28, left, top - 30, 'Print Better'),
    text('F1', 14, left, top - 52, 'Printer test page'),
    `q 1 w 0 G ${fmt(left)} ${fmt(top - 66)} m ${fmt(w - left)} ${fmt(top - 66)} l S Q`,
    ...rows.flatMap(([label, value], i) => [text('F2', 12, left, top - 96 - i * 20, label), text('F1', 12, left + 80, top - 96 - i * 20, value)]),
  ]
  const rampY = top - 230
  for (let i = 0; i < 6; i++) {
    const x = left + i * 72
    ops.push(`q ${fmt(1 - i * 0.2)} g ${fmt(x)} ${fmt(rampY)} 64 40 re f Q`, `q 0.5 w 0 G ${fmt(x)} ${fmt(rampY)} 64 40 re S Q`)
    ops.push(text('F1', 9, x, rampY - 14, `${i * 20}%`))
  }
  const cy = rampY - 150
  for (const r of [70, 50, 30, 10]) ops.push(`q 1 w 0 G ${circle(w / 2, cy, r)} S Q`)
  ops.push(`q 0.6 g ${circle(w / 2, cy, 6)} f Q`)
  ops.push(`q 1.5 w 0 G ${fmt(left)} ${fmt(cy - 60)} m ${fmt(left + 60)} ${fmt(cy + 60)} l ${fmt(left + 120)} ${fmt(cy - 60)} l h S Q`)
  ops.push(`q 0.85 g 0 G 1 w ${fmt(w - left - 120)} ${fmt(cy - 60)} 120 120 re B Q`)
  for (const [i, lw] of [0.25, 0.5, 1, 2, 4].entries()) {
    const y = cy - 120 - i * 14
    ops.push(`q ${lw} w 0 G ${fmt(left)} ${fmt(y)} m ${fmt(w - left - 50)} ${fmt(y)} l S Q`, text('F1', 8, w - left - 40, y - 3, `${lw} pt`))
  }
  ops.push(text('F1', 11, left, 72, 'If this page looks sharp and complete, the printer is ready to use.'))
  return ops.join('\n')
}

/** A valid one-page PDF 1.4 with correct cross-reference offsets. */
export function testPagePdf(p: TestPageInput): Uint8Array {
  const a4 = p.mediaDefault?.startsWith('iso_a4') ?? false
  const [w, h] = a4 ? [595.28, 841.89] : [612, 792]
  const content = drawing(p, w, h, a4 ? 'A4' : 'US Letter')
  const created = `D:${p.time.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`
  const font = (name: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font('Helvetica'),
    font('Helvetica-Bold'),
    `<< /Title (Print Better test page) /Producer (Print Better) /CreationDate (${created}) >>`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return utf8(out)
}
