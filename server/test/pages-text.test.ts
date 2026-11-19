import { describe, expect, it } from 'vitest'
import type { DocType } from '../shared/printing'
import { blobSource, bytesSource, countPages, type TextPaper } from '../shared/pages'

// US Letter portrait fits 60 lines of 90 characters; A4 portrait 64 of 87; Letter landscape 45 of 120.
const encoder = new TextEncoder()
const bytes = (data: string | number[]) => (typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data))
const text = (data: string | number[], paper?: TextPaper) => countPages(bytesSource(bytes(data)), 'text/plain', paper)
const lines = (n: number, line = 'line') => Array.from({ length: n }, () => line).join('\n')
const A4: TextPaper = { media: 'iso_a4_210x297mm', landscape: false }

function utf16(s: string, littleEndian: boolean): number[] {
  const out = littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i)
    out.push(...(littleEndian ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff]))
  }
  return out
}

describe('text pages, laid out like the client prints them', () => {
  it('fits 60 lines on a Letter page', async () => {
    expect(await text(lines(60))).toBe(1)
    expect(await text(lines(61))).toBe(2)
    expect(await text(lines(121))).toBe(3)
  })

  it('counts an empty file as one page and ignores one final newline', async () => {
    expect(await text('')).toBe(1)
    expect(await text(`${lines(60)}\n`)).toBe(1)
    expect(await text(`${lines(60)}\n\n`)).toBe(2)
  })

  it('wraps at the last space that fits, else mid-word', async () => {
    expect(await text(lines(30, 'x'.repeat(91)))).toBe(1)
    expect(await text(lines(31, 'x'.repeat(91)))).toBe(2)
    // Three 50-letter words take three lines each, where cutting mid-word would take two.
    expect(await text(lines(20, `${'y'.repeat(50)} `.repeat(3)))).toBe(1)
    expect(await text(lines(21, `${'y'.repeat(50)} `.repeat(3)))).toBe(2)
  })

  it('expands tabs to stops every 8 columns and drops carriage returns', async () => {
    expect(await text(lines(30, '\t'.repeat(12)))).toBe(1)
    expect(await text(lines(31, '\t'.repeat(12)))).toBe(2)
    expect(await text(lines(60, `${'x'.repeat(90)}\r`))).toBe(1)
  })

  it('starts a new page at each form feed', async () => {
    expect(await text('a\fb')).toBe(2)
    expect(await text('a\f')).toBe(1)
    expect(await text('\fa')).toBe(2)
    expect(await text('a\f\fb')).toBe(3)
  })

  it('uses the paper size and orientation', async () => {
    expect(await text(lines(61), A4)).toBe(1)
    expect(await text(lines(65), A4)).toBe(2)
    expect(await text(lines(61), { media: 'A4', landscape: false })).toBe(1)
    expect(await text(lines(33, 'x'.repeat(88)))).toBe(1)
    expect(await text(lines(33, 'x'.repeat(88)), A4)).toBe(2)
    expect(await text(lines(46), { media: null, landscape: true })).toBe(2)
    expect(await text(lines(61), { media: 'custom_unknown', landscape: false })).toBe(2)
  })

  it('reads UTF-8, UTF-16 with a byte order mark, and Windows-1252, a character per column', async () => {
    const emoji = (n: number) => lines(31, '😀'.repeat(n))
    expect(await text(emoji(90))).toBe(1)
    expect(await text(emoji(91))).toBe(2)
    expect(await text(utf16(emoji(90), true))).toBe(1)
    expect(await text(utf16(emoji(91), false))).toBe(2)
    expect(await text([0xef, 0xbb, 0xbf, ...encoder.encode(lines(60, 'x'.repeat(90)))])).toBe(1)
    const accented = (n: number) => Array.from({ length: 31 }, () => Array<number>(n).fill(0xe9)).flatMap((line) => [...line, 0x0a])
    expect(await text(accented(90))).toBe(1)
    expect(await text(accented(91))).toBe(2)
  })

  it('gives up on text files over 8 MB', async () => {
    const big = { size: 9 * 1024 * 1024, read: async (_offset: number, length: number) => new Uint8Array(length).fill(0x61) }
    expect(await countPages(big, 'text/plain')).toBeNull()
  })

  it('reads a browser File the same way', async () => {
    const file = new File([lines(61)], 'notes.txt', { type: 'text/plain' })
    expect(await countPages(blobSource(file), 'text/plain')).toBe(2)
  })
})

describe('other document types', () => {
  it('counts an image as one page and anything else as unknown', async () => {
    expect(await countPages(bytesSource(bytes([0xff, 0xd8, 0xff])), 'image/jpeg')).toBe(1)
    expect(await countPages(bytesSource(bytes([0x89, 0x50, 0x4e, 0x47])), 'image/png')).toBe(1)
    expect(await countPages(bytesSource(bytes('%!PS')), 'application/postscript' as DocType)).toBeNull()
  })
})
