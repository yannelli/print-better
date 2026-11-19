import { inflate } from './inflate'
import { type Dict, isName, type PdfValue } from './pdf-values'
import type { Budget } from './reader'

const list = (value: PdfValue | undefined): PdfValue[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])

/** A stream's data, unfiltered: none or FlateDecode, with or without a PNG predictor. */
export async function decodeStream(dict: Dict, raw: Uint8Array, budget: Budget): Promise<Uint8Array> {
  const filters = list(dict.get('Filter'))
  if (filters.length === 0) return raw
  if (filters.length > 1 || !(isName(filters[0], 'FlateDecode') || isName(filters[0], 'Fl'))) throw new Error('unsupported stream filter')
  const params = list(dict.get('DecodeParms'))[0]
  return unpredict(await inflate(raw, budget), params instanceof Map ? params : new Map())
}

function unpredict(data: Uint8Array, params: Dict): Uint8Array {
  const param = (key: string, fallback: number) => {
    const value = params.get(key)
    return typeof value === 'number' ? value : fallback
  }
  const predictor = param('Predictor', 1)
  if (predictor === 1) return data
  if (predictor < 10) throw new Error('TIFF predictors are not supported')
  const bits = param('Colors', 1) * param('BitsPerComponent', 8)
  const bpp = Math.max(1, Math.ceil(bits / 8))
  const width = Math.ceil((bits * param('Columns', 1)) / 8)
  const rows = Math.floor(data.length / (width + 1))
  const out = new Uint8Array(rows * width)
  for (let row = 0; row < rows; row++) {
    const filter = data[row * (width + 1)]
    const src = row * (width + 1) + 1
    const dst = row * width
    for (let i = 0; i < width; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0
      const up = row > 0 ? out[dst - width + i] : 0
      const upLeft = row > 0 && i >= bpp ? out[dst - width + i - bpp] : 0
      out[dst + i] = data[src + i] + predict(filter, left, up, upLeft)
    }
  }
  return out
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return (left + up) >> 1
  if (filter === 4) return paeth(left, up, upLeft)
  throw new Error(`unknown PNG filter ${filter}`)
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft
  const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
  return a <= b && a <= c ? left : b <= c ? up : upLeft
}
