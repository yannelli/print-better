import { type Indirect, isInt, Lexer } from './pdf-lexer'
import { decodeStream } from './pdf-stream'
import { int, type PdfValue, Ref } from './pdf-values'
import type { Xref } from './pdf-xref'
import type { Reader } from './reader'

const MAX_HOPS = 8

/** Resolves references through the cross-reference table, plain or inside object streams. */
export class Objects {
  private objectStreams = new Map<number, Promise<ObjectStream>>()

  constructor(
    private reader: Reader,
    private xref: Xref,
  ) {}

  async resolve(value: PdfValue | undefined): Promise<PdfValue | undefined> {
    for (let hops = 0; value instanceof Ref; hops++) {
      if (hops === MAX_HOPS) throw new Error('too many references')
      value = await this.get(value.num)
    }
    return value
  }

  private async get(num: number): Promise<PdfValue> {
    const entry = this.xref.entry(num)
    if (!entry) throw new Error(`object ${num} is not in the cross-reference table`)
    if ('offset' in entry) return (await this.plain(num, entry.offset)).value
    if (this.xref.encrypted) throw new Error('object streams of encrypted files cannot be read')
    let stream = this.objectStreams.get(entry.stream)
    if (!stream) this.objectStreams.set(entry.stream, (stream = this.objectStream(entry.stream)))
    return (await stream).object(num)
  }

  private async plain(num: number, offset: number): Promise<Indirect> {
    const object = await this.reader.parse(offset, (lexer) => lexer.indirect())
    if (object.num !== num) throw new Error(`object ${num} is not at offset ${offset}`)
    return object
  }

  private async objectStream(num: number): Promise<ObjectStream> {
    const entry = this.xref.entry(num)
    if (!entry || !('offset' in entry)) throw new Error(`object stream ${num} is not in the cross-reference table`)
    const { value: dict, streamStart } = await this.plain(num, entry.offset)
    if (!(dict instanceof Map) || streamStart === null) throw new Error(`object ${num} is not a stream`)
    const raw = await this.reader.bytes(entry.offset + streamStart, int(await this.resolve(dict.get('Length'))))
    return new ObjectStream(await decodeStream(dict, raw, this.reader.budget), int(dict.get('N')), int(dict.get('First')))
  }
}

class ObjectStream {
  private offsets = new Map<number, number>()

  constructor(
    private data: Uint8Array,
    count: number,
    first: number,
  ) {
    const header = new Lexer(data, 0, true)
    for (let i = 0; i < count; i++) {
      const [num, offset] = [header.word(), header.word()]
      if (!isInt(num) || !isInt(offset)) throw new Error('bad object stream header')
      this.offsets.set(Number(num), first + Number(offset))
    }
  }

  object(num: number): PdfValue {
    const at = this.offsets.get(num)
    if (at === undefined) throw new Error(`object ${num} is not in its object stream`)
    return new Lexer(this.data, at, true).value()
  }
}
