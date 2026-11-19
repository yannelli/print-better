import { describe, expect, it } from 'vitest'
import { blobSource, bytesSource, countPages } from '../shared/pages'
import { MAX_READ_BYTES, MAX_READS } from '../shared/pages/reader'
import type { ByteSource } from '../shared/usage'
import { type Entries, PdfWriter } from './helpers/pdf'

const pdf = (bytes: Uint8Array) => countPages(bytesSource(bytes), 'application/pdf')

/** Catalog 1 and page tree 2 over `pages` pages numbered from 3. */
function tree(pages: number, count: number | string = pages): [number, string][] {
  const kids = Array.from({ length: pages }, (_, i) => i + 3)
  return [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${count} >>`],
    ...kids.map((n): [number, string] => [n, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']),
  ]
}

/** An unlisted page tree root late in the file: a scan would take it, a count through the cross-reference table never sees it. */
const DECOY: [number, string] = [99, '<< /Type /Pages /Kids [] /Count 42 >>']

function plainFile(objects: [number, string][], trailer = '/Root 1 0 R'): Uint8Array {
  const w = new PdfWriter()
  for (const [n, body] of objects) w.obj(n, body)
  w.obj(...DECOY)
  return w.end(w.table(w.plain(0, ...objects.map(([n]) => n)), `/Size ${Math.max(...objects.map(([n]) => n)) + 1} ${trailer}`))
}

describe('PDF structure', () => {
  it('reads /Count through a classic cross-reference table', async () => {
    expect(await pdf(plainFile(tree(3)))).toBe(3)
  })

  it('accepts table entries that end in a single byte', async () => {
    const w = new PdfWriter()
    const offsets = tree(2).map(([n, body]) => w.obj(n, body))
    w.obj(...DECOY)
    const rows = offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n\n`).join('')
    const xref = w.raw(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f\n${rows}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`)
    expect(await pdf(w.end(xref))).toBe(2)
  })

  it('reads cross-reference streams, with every PNG predictor', async () => {
    const w = new PdfWriter()
    const objects = tree(5)
    for (const [n, body] of objects) w.obj(n, body)
    w.obj(...DECOY)
    const xref = await w.xrefStream(20, w.plain(0, ...objects.map(([n]) => n)), '/Root 1 0 R', [0, 1, 2, 3, 4])
    expect(await pdf(w.end(xref))).toBe(5)
  })

  it('finds the catalog and page tree inside an object stream whose /Length is a reference', async () => {
    const w = new PdfWriter()
    const packed = await w.objectStream(10, tree(4), { ref: 11 })
    const xref = await w.xrefStream(12, new Map([...w.plain(0, 10, 11), ...packed]), '/Root 1 0 R')
    expect(await pdf(w.end(xref))).toBe(4)
  })

  it('reads streams whose /Length also counts the end of line', async () => {
    const w = new PdfWriter()
    const packed = await w.objectStream(10, tree(6), { extra: 1 })
    const xref = await w.xrefStream(11, new Map([...w.plain(0, 10), ...packed]), '/Root 1 0 R')
    expect(await pdf(w.end(xref))).toBe(6)
  })

  it('follows /XRefStm in hybrid files, where the table lists packed objects as free', async () => {
    const w = new PdfWriter()
    const packed = await w.objectStream(10, tree(2))
    const stream = await w.xrefStream(11, new Map([...w.plain(0, 10), ...packed]), '')
    const free: Entries = new Map([...packed.keys()].map((n) => [n, { type: 0 }]))
    const xref = w.table(new Map([...w.plain(0, 10, 11), ...free]), `/Size 12 /Root 1 0 R /XRefStm ${stream}`)
    expect(await pdf(w.end(xref))).toBe(2)
  })

  it('takes the newest page tree after an incremental update, even when its trailer has no /Root', async () => {
    const w = new PdfWriter()
    for (const [n, body] of tree(2)) w.obj(n, body)
    const first = w.table(w.plain(0, 1, 2, 3, 4), '/Size 5 /Root 1 0 R')
    w.raw(`startxref\n${first}\n%%EOF\n`)
    w.obj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>')
    w.obj(5, '<< /Type /Page /Parent 2 0 R >>')
    w.obj(...DECOY)
    expect(await pdf(w.end(w.table(w.plain(2, 5), `/Size 6 /Prev ${first}`)))).toBe(3)
  })

  it('resolves an indirect /Count', async () => {
    expect(await pdf(plainFile([...tree(2, '9 0 R'), [9, '2']]))).toBe(2)
  })

  it('reads comments, nested and escaped strings, hex strings and escaped names', async () => {
    const catalog = '<< /Type /Catalog % the catalog\n /Title (Report \\(draft\\) (v2)) /ID [<0A1b> <ff>] /Pa#67es 2 0 R >>'
    expect(await pdf(plainFile([[1, catalog], ...tree(3).slice(1)]))).toBe(3)
  })

  it('reads objects larger than one read', async () => {
    const kids = Array.from({ length: 30_000 }, (_, i) => `${i + 3} 0 R`).join(' ')
    expect(await pdf(plainFile([tree(1)[0], [2, `<< /Type /Pages /Kids [${kids}] /Count 30000 >>`]]))).toBe(30_000)
  })

  it('reads a Blob the same way', async () => {
    expect(await countPages(blobSource(new Blob([plainFile(tree(7)) as Uint8Array<ArrayBuffer>])), 'application/pdf')).toBe(7)
  })
})

describe('PDF fallbacks', () => {
  it('scans for the page tree when the cross-reference table is missing or wrong', async () => {
    const w = new PdfWriter()
    for (const [n, body] of tree(3)) w.obj(n, body)
    expect(await pdf(w.bytes())).toBe(3)
    expect(await pdf(w.end(999_999))).toBe(3)
  })

  it('scans for the newest root and skips nodes that have a parent', async () => {
    const w = new PdfWriter()
    w.obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    w.obj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 4 >>')
    w.obj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 7 >>')
    w.obj(3, '<< /Type /Pages /Parent 2 0 R /Kids [6 0 R 7 0 R] /Count 2 >>')
    expect(await pdf(w.bytes())).toBe(7)
  })

  it('counts encrypted files with plain objects, not ones that pack them into object streams', async () => {
    expect(await pdf(plainFile(tree(2), '/Root 1 0 R /Encrypt 20 0 R'))).toBe(2)
    const w = new PdfWriter()
    const packed = await w.objectStream(10, tree(2))
    expect(await pdf(w.end(await w.xrefStream(11, new Map([...w.plain(0, 10), ...packed]), '/Root 1 0 R /Encrypt 20 0 R')))).toBeNull()
  })

  it('gives null for files that are not PDFs, have no pages, or fail to read', async () => {
    expect(await pdf(new TextEncoder().encode('Not a PDF at all'))).toBeNull()
    expect(await pdf(new Uint8Array())).toBeNull()
    const empty = new PdfWriter()
    for (const [n, body] of tree(0)) empty.obj(n, body)
    expect(await pdf(empty.end(empty.table(empty.plain(0, 1, 2), '/Size 3 /Root 1 0 R')))).toBeNull()
    const failing: ByteSource = { size: 4096, read: () => Promise.reject(new Error('storage is down')) }
    expect(await countPages(failing, 'application/pdf')).toBeNull()
  })

  it('stops after its read budget on a large file with no structure', async () => {
    const reads: number[] = []
    const source: ByteSource = {
      size: 2 ** 30,
      read: async (_offset, length) => {
        reads.push(length)
        return new Uint8Array(length)
      },
    }
    expect(await countPages(source, 'application/pdf')).toBeNull()
    expect(reads.length).toBeLessThanOrEqual(MAX_READS)
    expect(reads.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(MAX_READ_BYTES)
  })

  it('stops inflating a stream that grows past its budget', async () => {
    const w = new PdfWriter()
    const packed = await w.objectStream(10, [...tree(1), [9, `(${'x'.repeat(9 * 1024 * 1024)})`]])
    expect(await pdf(w.end(await w.xrefStream(11, new Map([...w.plain(0, 10), ...packed]), '/Root 1 0 R')))).toBeNull()
  })
})
