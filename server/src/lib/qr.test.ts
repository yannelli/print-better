import { describe, expect, it } from 'vitest'
import { formatBits, qrMatrix, rsEncode, versionBits } from './qr'

const binary = (value: number, width: number) => value.toString(2).padStart(width, '0')

describe('rsEncode', () => {
  it('produces the HELLO WORLD 1-M error correction codewords', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(rsEncode(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })
})

describe('formatBits', () => {
  it.each([
    [0, '101010000010010'],
    [1, '101000100100101'],
    [2, '101111001111100'],
    [3, '101101101001011'],
    [4, '100010111111001'],
    [5, '100000011001110'],
    [6, '100111110010111'],
    [7, '100101010100000'],
  ])('encodes level M with mask %i', (mask, bits) => {
    expect(binary(formatBits(mask), 15)).toBe(bits)
  })
})

describe('versionBits', () => {
  it('encodes version 7', () => {
    expect(binary(versionBits(7), 18)).toBe('000111110010010100')
  })
})

describe('qrMatrix', () => {
  it.each([
    [14, 1],
    [26, 2],
    [42, 3],
    [62, 4],
    [84, 5],
    [106, 6],
    [122, 7],
  ])('fits %i bytes in version %i and moves up one version for one more byte', (bytes, version) => {
    expect(qrMatrix('a'.repeat(bytes))).toHaveLength(17 + 4 * version)
    expect(qrMatrix('a'.repeat(bytes + 1))).toHaveLength(17 + 4 * (version + 1))
  })

  it('counts UTF-8 bytes, not characters', () => {
    expect(qrMatrix('é'.repeat(7))).toHaveLength(21)
    expect(qrMatrix('é'.repeat(7) + 'a')).toHaveLength(25)
  })

  it('returns a square matrix', () => {
    const matrix = qrMatrix('x'.repeat(300))
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true)
  })

  it('draws the three finder patterns with light separators', () => {
    const matrix = qrMatrix('HELLO WORLD')
    const size = matrix.length
    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const row = top + r
          const col = left + c
          if (row < 0 || col < 0 || row >= size || col >= size) continue
          const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
          expect(matrix[row][col], `module ${row},${col}`).toBe(ring !== 2 && ring !== 4)
        }
      }
    }
  })

  it('draws alternating timing patterns on row and column 6', () => {
    const matrix = qrMatrix('x'.repeat(300))
    for (let i = 8; i < matrix.length - 8; i++) {
      expect(matrix[6][i]).toBe(i % 2 === 0)
      expect(matrix[i][6]).toBe(i % 2 === 0)
    }
  })

  it('is deterministic', () => {
    const url = 'printbetter://pair?server=https%3A%2F%2Fyour-print-better.example&token=pbe_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG'
    expect(qrMatrix(url)).toEqual(qrMatrix(url))
  })

  it('throws when the text does not fit in version 40', () => {
    expect(qrMatrix('a'.repeat(2331))).toHaveLength(177)
    expect(() => qrMatrix('a'.repeat(2332))).toThrow(/too long/)
  })
})
