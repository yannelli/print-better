import { latin1 } from './bytes'
import { type Dict, Name, type PdfValue, Ref } from './pdf-values'

/** The parse ran past the end of a buffer that isn't the end of the file; `need` bytes would have been enough. */
export class Truncated extends Error {
  constructor(readonly need: number) {
    super('read window too short')
  }
}

export interface Indirect {
  num: number
  value: PdfValue
  /** Where the stream's data starts in the buffer, when the object is a stream. */
  streamStart: number | null
}

const SPACE = 1
const DELIMITER = 2
const CLASS = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = SPACE
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = DELIMITER

const [LF, CR, PERCENT, SLASH, LT, GT, LBRACKET, RBRACKET, LPAREN, RPAREN, BACKSLASH] = [...'\n\r%/<>[]()\\'].map((c) => c.charCodeAt(0))
const INTEGER = /^\d+$/
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

export const isInt = (word: string): boolean => INTEGER.test(word)
export const isSpace = (c: number): boolean => CLASS[c] === SPACE

/** Reads PDF tokens and objects from a buffer; `complete` means the buffer ends where the data ends. */
export class Lexer {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
    readonly complete = false,
  ) {}

  /** Skips whitespace and comments; false at the end of complete data. */
  more(): boolean {
    for (;;) {
      if (this.pos >= this.buf.length) return this.end()
      const c = this.buf[this.pos]
      if (c === PERCENT) this.skipComment()
      else if (CLASS[c] === SPACE) this.pos++
      else return true
    }
  }

  byte(at: number): number {
    if (at < this.buf.length) return this.buf[at]
    this.end()
    throw new Error('unexpected end of data')
  }

  /** A number or keyword; empty when a delimiter or the end comes first. */
  word(): string {
    return this.more() ? this.run() : ''
  }

  value(): PdfValue {
    const c = this.next()
    if (c === SLASH) {
      this.pos++
      return new Name(this.run().replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))))
    }
    if (c === LT) return this.byte(this.pos + 1) === LT ? this.dict() : this.hexString()
    if (c === LBRACKET) return this.array()
    if (c === LPAREN) return this.literalString()
    const word = this.run()
    if (NUMBER.test(word)) return this.numberOrRef(word)
    if (word === 'true' || word === 'false') return word === 'true'
    if (word === 'null') return null
    throw new Error(`unexpected "${word || String.fromCharCode(c)}"`)
  }

  /** `num gen obj value`, plus where the data starts when the value is a stream's dictionary. */
  indirect(): Indirect {
    const num = this.word()
    if (!isInt(num) || !isInt(this.word()) || this.word() !== 'obj') throw new Error('expected an object')
    const value = this.value()
    return { num: Number(num), value, streamStart: value instanceof Map && this.word() === 'stream' ? this.afterEol() : null }
  }

  private end(): false {
    if (this.complete) return false
    throw new Truncated(this.pos + 1)
  }

  private next(): number {
    if (!this.more()) throw new Error('unexpected end of data')
    return this.buf[this.pos]
  }

  private run(): string {
    const start = this.pos
    while (this.pos < this.buf.length && CLASS[this.buf[this.pos]] === 0) this.pos++
    if (this.pos === this.buf.length) this.end()
    return latin1(this.buf.subarray(start, this.pos))
  }

  private skipComment(): void {
    while (this.pos < this.buf.length && this.buf[this.pos] !== LF && this.buf[this.pos] !== CR) this.pos++
  }

  private numberOrRef(word: string): number | Ref {
    const start = this.pos
    if (isInt(word)) {
      const gen = this.word()
      if (isInt(gen) && this.word() === 'R') return new Ref(Number(word))
    }
    this.pos = start
    return Number(word)
  }

  private dict(): Dict {
    this.pos += 2
    const dict: Dict = new Map()
    while (this.next() !== GT) {
      const key = this.value()
      if (!(key instanceof Name)) throw new Error('dictionary key is not a name')
      dict.set(key.name, this.value())
    }
    if (this.byte(this.pos + 1) !== GT) throw new Error('expected >>')
    this.pos += 2
    return dict
  }

  private array(): PdfValue[] {
    this.pos++
    const items: PdfValue[] = []
    while (this.next() !== RBRACKET) items.push(this.value())
    this.pos++
    return items
  }

  private literalString(): string {
    const start = this.pos
    for (let depth = 0; ; ) {
      const c = this.byte(this.pos++)
      if (c === BACKSLASH) this.pos++
      else if (c === LPAREN) depth++
      else if (c === RPAREN && --depth === 0) return latin1(this.buf.subarray(start + 1, this.pos - 1))
    }
  }

  private hexString(): string {
    const start = ++this.pos
    while (this.byte(this.pos) !== GT) this.pos++
    return latin1(this.buf.subarray(start, this.pos++))
  }

  private afterEol(): number {
    if (this.byte(this.pos) === CR) this.pos++
    if (this.byte(this.pos) === LF) this.pos++
    return this.pos
  }
}
