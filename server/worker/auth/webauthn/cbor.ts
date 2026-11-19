// Minimal CBOR (RFC 8949) decoder for WebAuthn: definite lengths only, as CTAP2 canonical encoding requires.

export type Cbor = number | Uint8Array | string | boolean | null | Cbor[] | Map<Cbor, Cbor>

class Reader {
  pos: number
  private view: DataView

  constructor(
    private data: Uint8Array,
    start: number,
  ) {
    this.pos = start
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) throw new Error('CBOR: unexpected end of data')
  }

  private uint(info: number): number {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (size === 0) throw new Error('CBOR: indefinite or reserved length')
    this.need(size)
    const at = this.pos
    this.pos += size
    if (size === 1) return this.view.getUint8(at)
    if (size === 2) return this.view.getUint16(at)
    if (size === 4) return this.view.getUint32(at)
    const big = this.view.getBigUint64(at)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: integer too large')
    return Number(big)
  }

  private bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.data.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  item(depth = 0): Cbor {
    if (depth > 16) throw new Error('CBOR: nesting too deep')
    this.need(1)
    const initial = this.data[this.pos++]
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0:
        return this.uint(info)
      case 1:
        return -1 - this.uint(info)
      case 2:
        return this.bytes(this.uint(info))
      case 3:
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes(this.uint(info)))
      case 4: {
        const n = this.uint(info)
        return Array.from({ length: n }, () => this.item(depth + 1))
      }
      case 5: {
        const n = this.uint(info)
        const map = new Map<Cbor, Cbor>()
        for (let i = 0; i < n; i++) map.set(this.item(depth + 1), this.item(depth + 1))
        return map
      }
      case 6:
        this.uint(info)
        return this.item(depth + 1)
      default:
        return this.simple(info)
    }
  }

  private simple(info: number): Cbor {
    if (info === 20) return false
    if (info === 21) return true
    if (info === 22 || info === 23) return null
    if (info === 26 || info === 27) {
      const size = info === 26 ? 4 : 8
      this.need(size)
      const at = this.pos
      this.pos += size
      return size === 4 ? this.view.getFloat32(at) : this.view.getFloat64(at)
    }
    throw new Error('CBOR: unsupported simple value')
  }
}

/** Decodes one item starting at `offset`; `end` is the index just past it. */
export function decodeCbor(data: Uint8Array, offset = 0): { value: Cbor; end: number } {
  const reader = new Reader(data, offset)
  const value = reader.item()
  return { value, end: reader.pos }
}

export function asMap(v: Cbor, what: string): Map<Cbor, Cbor> {
  if (!(v instanceof Map)) throw new Error(`${what} must be a CBOR map`)
  return v
}
