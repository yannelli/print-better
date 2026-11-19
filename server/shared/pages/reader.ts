import type { ByteSource } from '../usage'
import { Lexer, Truncated } from './pdf-lexer'

export const WINDOW = 128 * 1024
export const MAX_READS = 20
export const MAX_READ_BYTES = 16 * 1024 * 1024
const MAX_INFLATED = 8 * 1024 * 1024

/** Caps the work per document, so a large or hostile file costs little CPU and memory. */
export class Budget {
  reads = 0
  bytes = 0
  inflated = 0

  constructor(
    public maxReads: number,
    public maxBytes: number,
  ) {}

  read(length: number): void {
    if (this.reads >= this.maxReads || this.bytes + length > this.maxBytes) throw new Error('read budget exceeded')
    this.reads++
    this.bytes += length
  }

  get inflateLeft(): number {
    return MAX_INFLATED - this.inflated
  }
}

interface Chunk {
  offset: number
  data: Uint8Array
}

/** Reads through the budget and keeps what it read, so overlapping requests cost nothing. */
export class Reader {
  private chunks: Chunk[] = []

  constructor(
    private source: ByteSource,
    readonly budget: Budget,
  ) {}

  get size(): number {
    return this.source.size
  }

  /** Bytes from `offset`, fewer at the end of the file. */
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > end) throw new Error(`offset ${offset} is outside the file`)
    const hit = this.chunks.find((c) => c.offset <= offset && end <= c.offset + c.data.length)
    if (hit) return hit.data.subarray(offset - hit.offset, end - hit.offset)
    this.budget.read(end - offset)
    const data = await this.source.read(offset, end - offset)
    if (data.length !== end - offset) throw new Error('short read')
    this.chunks = this.chunks.filter((c) => c.offset < offset || c.offset + c.data.length > end)
    this.chunks.push({ offset, data })
    return data
  }

  /** Parses from `offset`, reading a larger window while the parse runs past the end of the one it has. */
  async parse<T>(offset: number, parse: (lexer: Lexer) => T): Promise<T> {
    for (let length = WINDOW; ; ) {
      const buf = await this.bytes(offset, length)
      try {
        return parse(new Lexer(buf, 0, offset + buf.length >= this.size))
      } catch (e) {
        if (!(e instanceof Truncated)) throw e
        length = Math.max(length * 4, e.need + WINDOW)
      }
    }
  }
}
