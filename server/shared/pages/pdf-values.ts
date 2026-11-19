export class Name {
  constructor(readonly name: string) {}
}

export class Ref {
  constructor(readonly num: number) {}
}

export type Dict = Map<string, PdfValue>
export type PdfValue = number | boolean | null | string | Name | Ref | Dict | PdfValue[]

export const isName = (value: PdfValue | undefined, name: string): boolean => value instanceof Name && value.name === name

export function int(value: PdfValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('expected a non-negative integer')
  return value
}

export function ints(value: PdfValue | undefined): number[] {
  if (!Array.isArray(value)) throw new Error('expected an array')
  return value.map(int)
}

/** A page tree's `/Count` when it is a plausible number of pages. */
export const pageCount = (value: PdfValue | undefined): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null)
