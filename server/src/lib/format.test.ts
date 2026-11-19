import { describe, expect, it } from 'vitest'
import { bytes, initials, paperName, plural, timeAgo } from './format'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const MIN = 60_000

describe('timeAgo', () => {
  it('says never for missing times and just now for the last 45 seconds', () => {
    expect(timeAgo(null, NOW)).toBe('never')
    expect(timeAgo(undefined, NOW)).toBe('never')
    expect(timeAgo(NOW - 44_000, NOW)).toBe('just now')
    expect(timeAgo(NOW + 10_000, NOW)).toBe('just now')
  })

  it('picks the largest whole unit', () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    expect(timeAgo(NOW - 5 * MIN, NOW)).toBe(rtf.format(-5, 'minute'))
    expect(timeAgo(NOW - 3 * 60 * MIN, NOW)).toBe(rtf.format(-3, 'hour'))
    expect(timeAgo(NOW - 26 * 60 * MIN, NOW)).toBe(rtf.format(-1, 'day'))
    expect(timeAgo(NOW - 15 * 24 * 60 * MIN, NOW)).toBe(rtf.format(-2, 'week'))
    expect(timeAgo(NOW + 2 * 60 * MIN, NOW)).toBe(rtf.format(2, 'hour'))
  })
})

describe('bytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [184_320, '180 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [50 * 1024 * 1024, '50 MB'],
    [3 * 1024 ** 3, '3.0 GB'],
    [4096 * 1024 ** 3, '4096 GB'],
  ])('%d bytes is %s', (n, text) => expect(bytes(n)).toBe(text))
})

describe('plural', () => {
  it('uses the singular only for one', () => {
    expect(plural(1, 'printer')).toBe('1 printer')
    expect(plural(0, 'printer')).toBe('0 printers')
    expect(plural(3, 'copy', 'copies')).toBe('3 copies')
  })
})

describe('paperName', () => {
  it.each([
    ['na_letter_8.5x11in', 'Letter (8.5 × 11 in)'],
    ['na_legal_8.5x14in', 'Legal (8.5 × 14 in)'],
    ['iso_a4_210x297mm', 'A4 (210 × 297 mm)'],
    ['na_index-4x6_4x6in', '4 × 6 in photo'],
    ['na_5x7_5x7in', '5 × 7 in photo'],
    ['na_number-10_4.125x9.5in', '#10 envelope (4.125 × 9.5 in)'],
    ['om_small-photo_100x150mm', 'Small photo (100 × 150 mm)'],
    ['na_foo-bar_5x7in', 'Foo bar (5 × 7 in)'],
  ])('%s reads as %s', (media, name) => expect(paperName(media)).toBe(name))

  it('leaves names it cannot parse unchanged', () => {
    expect(paperName('custom')).toBe('custom')
    expect(paperName('')).toBe('')
  })
})

describe('initials', () => {
  it.each([
    ['Margaret Lewis', 'ML'],
    ['margaret', 'M'],
    ['Ana María de la Cruz', 'AC'],
    ['  ', '?'],
  ])('%j gives %s', (name, out) => expect(initials(name)).toBe(out))
})
