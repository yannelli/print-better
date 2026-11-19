// Builds PDF fixtures byte by byte: objects, object streams, and cross-reference tables or streams with correct offsets.

const encoder = new TextEncoder()
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data)

export async function deflate(data: string | Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytesOf(data) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export type Entry = { type: 0 } | { type: 1; offset: number } | { type: 2; stream: number; index: number }
export type Entries = Map<number, Entry>

/** `ref`: write /Length as a reference to that object number; `extra`: overstate it, as writers that count the end of line do. */
export interface LengthStyle {
  ref?: number
  extra?: number
}

export class PdfWriter {
  private parts: Uint8Array[] = []
  private length = 0
  private offsets = new Map<number, number>()

  constructor(header = '%PDF-1.7\n') {
    this.raw(header)
  }

  raw(data: string | Uint8Array): number {
    const bytes = bytesOf(data)
    this.parts.push(bytes)
    this.length += bytes.length
    return this.length - bytes.length
  }

  obj(num: number, body: string): number {
    this.offsets.set(num, this.length)
    return this.raw(`${num} 0 obj\n${body}\nendobj\n`)
  }

  stream(num: number, dict: string, data: Uint8Array, length: LengthStyle = {}): number {
    const size = String(data.length + (length.extra ?? 0))
    const at = this.raw(`${num} 0 obj\n<< ${dict} /Length ${length.ref ? `${length.ref} 0 R` : size} >>\nstream\n`)
    this.offsets.set(num, at)
    this.raw(data)
    this.raw('\nendstream\nendobj\n')
    if (length.ref) this.obj(length.ref, size)
    return at
  }

  /** Object stream `num` holding `objects`; returns their entries. */
  async objectStream(num: number, objects: [number, string][], length?: LengthStyle): Promise<Entries> {
    let header = ''
    let body = ''
    for (const [n, text] of objects) {
      header += `${n} ${body.length} `
      body += `${text}\n`
    }
    this.stream(num, `/Type /ObjStm /N ${objects.length} /First ${header.length} /Filter /FlateDecode`, await deflate(header + body), length)
    return new Map(objects.map(([n], index) => [n, { type: 2, stream: num, index }]))
  }

  /** Entries for objects written so far; the ones not written are free. */
  plain(...nums: number[]): Entries {
    return new Map(nums.map((n): [number, Entry] => [n, this.offsets.has(n) ? { type: 1, offset: this.offsets.get(n)! } : { type: 0 }]))
  }

  /** A classic `xref` table and its trailer; returns the table's offset. */
  table(entries: Entries, trailer: string): number {
    const lines = runs([...entries.keys()]).flatMap((run) => [
      `${run[0]} ${run.length}\n`,
      ...run.map((n) => {
        const entry = entries.get(n)!
        if (entry.type === 2) throw new Error('tables cannot point into object streams')
        return entry.type === 1 ? `${String(entry.offset).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n'
      }),
    ])
    return this.raw(`xref\n${lines.join('')}trailer\n<< ${trailer} >>\n`)
  }

  /** Cross-reference stream `num` listing `entries` and itself; `filters` are PNG predictor filters used row by row in turn. */
  async xrefStream(num: number, entries: Entries, trailer: string, filters: number[] = []): Promise<number> {
    const all = new Map(entries).set(num, { type: 1, offset: this.length })
    const nums = [...all.keys()].sort((a, b) => a - b)
    const rows = nums.map((n) => xrefRow(all.get(n)!))
    const index = runs(nums).map((run) => `${run[0]} ${run.length}`)
    const params = filters.length ? ' /DecodeParms << /Predictor 12 /Columns 7 >>' : ''
    const data = await deflate(filters.length ? pngRows(rows, filters) : concat(rows))
    return this.stream(num, `/Type /XRef /Size ${nums.at(-1)! + 1} /Index [${index.join(' ')}] /W [1 4 2] /Filter /FlateDecode${params} ${trailer}`, data)
  }

  /** Ends the file pointing at the cross-reference section at `xref`. */
  end(xref: number): Uint8Array {
    this.raw(`startxref\n${xref}\n%%EOF\n`)
    return this.bytes()
  }

  bytes(): Uint8Array {
    return concat(this.parts)
  }
}

function runs(nums: number[]): number[][] {
  const out: number[][] = []
  for (const n of [...nums].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && last.at(-1) === n - 1) last.push(n)
    else out.push([n])
  }
  return out
}

function xrefRow(entry: Entry): Uint8Array {
  const [a, b] = entry.type === 1 ? [entry.offset, 0] : entry.type === 2 ? [entry.stream, entry.index] : [0, 0]
  return new Uint8Array([entry.type, a >>> 24, a >>> 16, a >>> 8, a, b >>> 8, b])
}

function pngRows(rows: Uint8Array[], filters: number[]): Uint8Array {
  const out: number[] = []
  rows.forEach((row, r) => {
    const up = rows[r - 1] ?? new Uint8Array(row.length)
    const filter = filters[r % filters.length]
    out.push(filter, ...row.map((x, i) => x - pngPredict(filter, row[i - 1] ?? 0, up[i], up[i - 1] ?? 0)))
  })
  return new Uint8Array(out)
}

function pngPredict(filter: number, left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft
  const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
  return [0, left, up, (left + up) >> 1, a <= b && a <= c ? left : b <= c ? up : upLeft][filter]
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0)
  return out
}
