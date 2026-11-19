import { lastIndexOf, latin1 } from './bytes'
import { type Indirect, isInt, isSpace, Lexer } from './pdf-lexer'
import { decodeStream } from './pdf-stream'
import { type Dict, int, ints, isName, type PdfValue } from './pdf-values'
import { type Reader, WINDOW } from './reader'

/** Where an object is: at a file offset, or inside an object stream. */
export type XrefEntry = { offset: number } | { stream: number }

interface Section {
  entry(num: number): XrefEntry | undefined
}

interface Parsed {
  section: Section
  trailer: Dict
}

/** All cross-reference sections, newest first, from `startxref` along the `/Prev` chain. */
export class Xref {
  constructor(
    private sections: Section[],
    private trailers: Dict[],
  ) {}

  /** The newest entry in use; hybrid files list their compressed objects as free in the table. */
  entry(num: number): XrefEntry | undefined {
    for (const section of this.sections) {
      const entry = section.entry(num)
      if (entry) return entry
    }
  }

  get root(): PdfValue | undefined {
    return this.trailers.find((t) => t.has('Root'))?.get('Root')
  }

  get encrypted(): boolean {
    return this.trailers.some((t) => t.has('Encrypt'))
  }
}

export async function loadXref(reader: Reader): Promise<Xref> {
  const sections: Section[] = []
  const trailers: Dict[] = []
  const seen = new Set<number>()
  for (let offset: PdfValue | undefined = await startxref(reader); typeof offset === 'number' && !seen.has(offset); ) {
    seen.add(offset)
    const { section, trailer } = await readSection(reader, offset)
    sections.push(section)
    trailers.push(trailer)
    const stream = trailer.get('XRefStm')
    if (typeof stream === 'number') sections.push((await readSection(reader, stream)).section)
    offset = trailer.get('Prev')
  }
  return new Xref(sections, trailers)
}

async function startxref(reader: Reader): Promise<number> {
  const start = Math.max(0, reader.size - WINDOW)
  const tail = await reader.bytes(start, reader.size - start)
  const at = lastIndexOf(tail, 'startxref')
  const offset = at < 0 ? '' : new Lexer(tail, at + 9, true).word()
  if (!isInt(offset)) throw new Error('no startxref')
  return Number(offset)
}

async function readSection(reader: Reader, offset: number): Promise<Parsed> {
  const parsed = await reader.parse(offset, (lexer): Parsed | Indirect => {
    if (lexer.word() === 'xref') return table(lexer)
    lexer.pos = 0
    return lexer.indirect()
  })
  return 'section' in parsed ? parsed : streamSection(reader, offset, parsed)
}

function table(lexer: Lexer): Parsed {
  const subsections: Subsection[] = []
  for (let word = lexer.word(); word !== 'trailer'; word = lexer.word()) {
    const count = lexer.word()
    if (!isInt(word) || !isInt(count)) throw new Error('bad cross-reference subsection')
    lexer.more()
    const sub = { first: Number(word), count: Number(count), at: lexer.pos, stride: Number(count) > 0 ? entryStride(lexer) : 0 }
    subsections.push(sub)
    lexer.pos = sub.at + sub.count * sub.stride
  }
  const trailer = lexer.value()
  if (!(trailer instanceof Map)) throw new Error('bad trailer')
  return { section: new TableSection(lexer.buf, subsections), trailer }
}

/** Entries are 20 bytes, but some writers end them with a single byte. */
function entryStride(lexer: Lexer): number {
  let stride = 18
  while (stride < 20 && isSpace(lexer.byte(lexer.pos + stride))) stride++
  if (stride === 18) throw new Error('bad cross-reference entry')
  return stride
}

interface Subsection {
  first: number
  count: number
  at: number
  stride: number
}

class TableSection implements Section {
  constructor(
    private buf: Uint8Array,
    private subsections: Subsection[],
  ) {}

  entry(num: number): XrefEntry | undefined {
    const sub = this.subsections.find((s) => num >= s.first && num < s.first + s.count)
    if (!sub) return undefined
    const at = sub.at + (num - sub.first) * sub.stride
    const offset = Number(latin1(this.buf.subarray(at, at + 10)))
    return this.buf[at + 17] === 0x6e && offset > 0 ? { offset } : undefined
  }
}

async function streamSection(reader: Reader, offset: number, object: Indirect): Promise<Parsed> {
  const dict = object.value
  if (!(dict instanceof Map) || object.streamStart === null || !isName(dict.get('Type'), 'XRef')) throw new Error('not a cross-reference stream')
  const widths = ints(dict.get('W'))
  if (widths.length !== 3 || widths.some((w) => w > 7)) throw new Error('bad /W')
  const raw = await reader.bytes(offset + object.streamStart, int(dict.get('Length')))
  const data = await decodeStream(dict, raw, reader.budget)
  const index = dict.has('Index') ? ints(dict.get('Index')) : [0, int(dict.get('Size'))]
  return { section: new StreamSection(data, widths, index), trailer: dict }
}

class StreamSection implements Section {
  private rowLength: number

  constructor(
    private data: Uint8Array,
    private widths: number[],
    private index: number[],
  ) {
    this.rowLength = widths[0] + widths[1] + widths[2]
  }

  entry(num: number): XrefEntry | undefined {
    for (let i = 0, row = 0; i + 1 < this.index.length; row += this.index[i + 1], i += 2) {
      if (num >= this.index[i] && num < this.index[i] + this.index[i + 1]) return this.row(row + num - this.index[i])
    }
  }

  private row(row: number): XrefEntry | undefined {
    const [w0, w1] = this.widths
    const at = row * this.rowLength
    if (at + this.rowLength > this.data.length) return undefined
    const type = w0 ? this.field(at, w0) : 1
    const value = this.field(at + w0, w1)
    if (type === 1 && value > 0) return { offset: value }
    if (type === 2) return { stream: value }
  }

  private field(at: number, width: number): number {
    let value = 0
    for (let i = 0; i < width; i++) value = value * 256 + this.data[at + i]
    return value
  }
}
