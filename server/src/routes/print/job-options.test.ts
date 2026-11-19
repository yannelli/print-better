import { describe, expect, it } from 'vitest'
import { DEFAULT_PRINTER_SETTINGS, type JobOptions, type Printer } from '@shared/types'
import { changedOptions, PAGE_RANGES, paperChoices, startingOptions } from './job-options'

function printer(defaults: JobOptions, color = true): Printer {
  return {
    id: 'p1',
    workspaceId: 'w',
    clientId: 'c',
    clientName: 'Mac',
    clientOnline: true,
    added: true,
    defaults,
    settings: DEFAULT_PRINTER_SETTINGS,
    createdAt: 0,
    updatedAt: 0,
    key: 'k',
    name: 'P',
    makeModel: null,
    uuid: null,
    location: null,
    local: false,
    routes: [],
    capabilities: {
      formats: [],
      color,
      duplex: true,
      media: ['iso_a4_210x297mm', 'na_letter_8.5x11in'],
      mediaDefault: 'na_letter_8.5x11in',
      resolutions: [],
      copiesMax: 99,
    },
    status: { state: 'idle', reasons: [], message: null, supplies: [] },
  }
}

describe('startingOptions', () => {
  it('fills sensible fallbacks around the printer defaults', () => {
    expect(startingOptions(printer({}))).toEqual({
      copies: 1,
      colorMode: 'color',
      sides: 'one-sided',
      media: 'na_letter_8.5x11in',
      orientation: 'auto',
      fit: 'fit',
      quality: 'normal',
      pageRanges: '',
    })
  })

  it('keeps the printer defaults and forces black and white on mono printers', () => {
    const start = startingOptions(printer({ copies: 2, media: 'iso_a4_210x297mm', sides: 'two-sided-long-edge', colorMode: 'color' }, false))
    expect(start).toMatchObject({ copies: 2, media: 'iso_a4_210x297mm', sides: 'two-sided-long-edge', colorMode: 'monochrome' })
  })

  it('respects a monochrome default on a color printer', () => {
    expect(startingOptions(printer({ colorMode: 'monochrome' })).colorMode).toBe('monochrome')
  })
})

describe('changedOptions', () => {
  const start = startingOptions(printer({}))

  it('sends nothing when nothing changed', () => {
    expect(changedOptions(start, { ...start })).toEqual({})
  })

  it('sends only the fields someone changed', () => {
    expect(changedOptions(start, { ...start, copies: 3, sides: 'two-sided-short-edge' })).toEqual({
      copies: 3,
      sides: 'two-sided-short-edge',
    })
  })

  it('skips empty page ranges and undefined values', () => {
    expect(changedOptions(start, { ...start, pageRanges: '', quality: undefined })).toEqual({})
    expect(changedOptions(start, { ...start, pageRanges: '1-3, 5' })).toEqual({ pageRanges: '1-3, 5' })
  })
})

describe('page ranges', () => {
  it.each(['1', '1-3', '1-3, 5', ' 2 , 4-6 ,8 '])('accepts %j', (v) => expect(PAGE_RANGES.test(v)).toBe(true))
  it.each(['', 'all', '1-', '-3', '1,,2', '1-3-5', '1;2'])('rejects %j', (v) => expect(PAGE_RANGES.test(v)).toBe(false))
})

it('labels paper choices in plain words', () => {
  expect(paperChoices(printer({}))).toEqual([
    { value: 'iso_a4_210x297mm', label: 'A4 (210 × 297 mm)' },
    { value: 'na_letter_8.5x11in', label: 'Letter (8.5 × 11 in)' },
  ])
})
