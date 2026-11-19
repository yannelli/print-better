type Cell = [row: number, col: number]
type Grid = { dark: boolean[][]; reserved: boolean[][] }

const EC_PER_BLOCK = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28,
]
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47,
  49,
]
const LEVEL_M = 0b00

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

const EXP: number[] = []
const LOG: number[] = []
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) {
  EXP[i] = EXP[i + 255] = x
  LOG[x] = i
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)
const bit = (value: number, i: number) => ((value >>> i) & 1) === 1
const countBits = (version: number) => (version < 10 ? 8 : 16)

/** QR code modules (true = dark, no quiet zone) for `text` as UTF-8 bytes at level M, in the smallest version that fits. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const { version, grid, dataCodewords } = fitVersion(bytes.length)
  placeCodewords(grid, addErrorCorrection(encodeData(bytes, version, dataCodewords), version))
  const candidates = MASKS.map((mask, i) => {
    const masked = grid.dark.map((row, r) => row.map((on, c) => on !== (!grid.reserved[r][c] && mask(r, c))))
    const format = formatBits(i)
    formatCells(masked.length).forEach((copies, j) => copies.forEach(([r, c]) => (masked[r][c] = bit(format, j))))
    return masked
  })
  const scores = candidates.map(penalty)
  return candidates[scores.indexOf(Math.min(...scores))]
}

function fitVersion(byteLength: number) {
  for (let version = 1; version <= 40; version++) {
    const grid = functionPatterns(version)
    const totalCodewords = grid.reserved.flat().filter((taken) => !taken).length >> 3
    const dataCodewords = totalCodewords - EC_PER_BLOCK[version - 1] * BLOCKS[version - 1]
    if (4 + countBits(version) + byteLength * 8 <= dataCodewords * 8) return { version, grid, dataCodewords }
  }
  throw new Error(`Text is too long for a QR code: ${byteLength} bytes, the limit is 2331`)
}

function encodeData(bytes: Uint8Array, version: number, capacity: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacity * 8 - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0))
  for (let pad = 0xec; words.length < capacity; pad ^= 0xec ^ 0x11) words.push(pad)
  return words
}

function addErrorCorrection(data: number[], version: number): number[] {
  const blockCount = BLOCKS[version - 1]
  const shortLength = Math.floor(data.length / blockCount)
  const longFrom = blockCount - (data.length % blockCount)
  const blocks: number[][] = []
  for (let b = 0, start = 0; b < blockCount; b++) {
    const end = start + shortLength + (b >= longFrom ? 1 : 0)
    blocks.push(data.slice(start, end))
    start = end
  }
  return [...interleave(blocks), ...interleave(blocks.map((block) => rsEncode(block, EC_PER_BLOCK[version - 1])))]
}

function interleave(lists: number[][]): number[] {
  const out: number[] = []
  const longest = Math.max(...lists.map((list) => list.length))
  for (let i = 0; i < longest; i++) for (const list of lists) if (i < list.length) out.push(list[i])
  return out
}

export function rsEncode(data: number[], ecLength: number): number[] {
  let generator = [1]
  for (let i = 0; i < ecLength; i++) {
    const next = new Array<number>(generator.length + 1).fill(0)
    generator.forEach((coef, j) => {
      next[j] ^= coef
      next[j + 1] ^= mul(coef, EXP[i])
    })
    generator = next
  }
  const remainder = new Array<number>(ecLength).fill(0)
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0)
    remainder.push(0)
    for (let j = 0; j < ecLength; j++) remainder[j] ^= mul(generator[j + 1], factor)
  }
  return remainder
}

export function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask
  return ((data << 10) | bchRemainder(data, 10, 0x537)) ^ 0x5412
}

export function versionBits(version: number): number {
  return (version << 12) | bchRemainder(version, 12, 0x1f25)
}

function bchRemainder(data: number, degree: number, generator: number): number {
  let remainder = data
  for (let i = 0; i < degree; i++) remainder = (remainder << 1) ^ ((remainder >>> (degree - 1)) * generator)
  return remainder
}

function functionPatterns(version: number): Grid {
  const size = version * 4 + 17
  const blank = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const grid = { dark: blank(), reserved: blank() }
  const set = (r: number, c: number, on: boolean) => {
    grid.dark[r][c] = on
    grid.reserved[r][c] = true
  }
  const square = (row: number, col: number, radius: number, isDark: (ring: number) => boolean) => {
    for (let r = Math.max(0, row - radius); r <= Math.min(size - 1, row + radius); r++) {
      for (let c = Math.max(0, col - radius); c <= Math.min(size - 1, col + radius); c++) {
        set(r, c, isDark(Math.max(Math.abs(r - row), Math.abs(c - col))))
      }
    }
  }
  for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) square(r, c, 4, (ring) => ring !== 2 && ring !== 4)
  const centers = alignmentCenters(version)
  for (const r of centers) for (const c of centers) if (!grid.reserved[r][c]) square(r, c, 2, (ring) => ring !== 1)
  for (let i = 0; i < size; i++) {
    if (!grid.reserved[6][i]) set(6, i, i % 2 === 0)
    if (!grid.reserved[i][6]) set(i, 6, i % 2 === 0)
  }
  for (const [r, c] of formatCells(size).flat()) set(r, c, false)
  set(size - 8, 8, true)
  if (version >= 7) {
    const info = versionBits(version)
    versionCells(size).forEach((copies, i) => copies.forEach(([r, c]) => set(r, c, bit(info, i))))
  }
  return grid
}

// Evenly spaced from the last center back toward 6, rounded to even steps; version 32 is the one exception.
function alignmentCenters(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const last = version * 4 + 10
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (count - 1) / 2) * 2
  return [6, ...Array.from({ length: count - 1 }, (_, i) => last - (count - 2 - i) * step)]
}

// Both copies of format bit i (LSB first), stepping around the timing row and column.
function formatCells(size: number): Cell[][] {
  return Array.from({ length: 15 }, (_, i): Cell[] => [
    i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : i === 8 ? [8, 7] : [8, 14 - i],
    i < 8 ? [8, size - 1 - i] : [size - 15 + i, 8],
  ])
}

function versionCells(size: number): Cell[][] {
  return Array.from({ length: 18 }, (_, i): Cell[] => {
    const near = Math.floor(i / 3)
    const far = size - 11 + (i % 3)
    return [
      [near, far],
      [far, near],
    ]
  })
}

function placeCodewords({ dark, reserved }: Grid, codewords: number[]) {
  const size = dark.length
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (reserved[row][col] || i >= codewords.length * 8) continue
        dark[row][col] = bit(codewords[i >>> 3], 7 - (i & 7))
        i++
      }
    }
  }
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length
  const rows = matrix.map((row) => row.map(Number).join(''))
  const cols = matrix.map((_, c) => matrix.map((row) => Number(row[c])).join(''))
  let score = 0
  for (const line of [...rows, ...cols]) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2
    score += (line.match(/(?=10111010000|00001011101)/g)?.length ?? 0) * 40
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const on = matrix[r][c]
      if (matrix[r][c + 1] === on && matrix[r + 1][c] === on && matrix[r + 1][c + 1] === on) score += 3
    }
  }
  const darkPercent = (rows.join('').replaceAll('0', '').length * 100) / size ** 2
  return score + Math.floor(Math.abs(darkPercent - 50) / 5) * 10
}
