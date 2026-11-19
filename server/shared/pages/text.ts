import type { ByteSource } from '../usage'
import { latin1 } from './bytes'
import { LETTER, parseMedia } from './media'

/** Paper for laying out text: a PWG media name (the job's media, else the printer's default); null or unparsable means US Letter. */
export interface TextPaper {
  media: string | null
  landscape: boolean
}

const MAX_TEXT = 8 * 1024 * 1024
const MARGIN = 36
const CHAR_WIDTH = 6
const LEADING = 12
const TAB = 8

/** Pages as the client lays out text (client/crates/print/src/convert/text.rs): Courier 10 pt with word wrap and form feeds. */
export async function countText(source: ByteSource, paper?: TextPaper): Promise<number | null> {
  if (source.size > MAX_TEXT) return null
  const media = (paper?.media ? parseMedia(paper.media) : null) ?? LETTER
  const [width, height] = paper?.landscape ? [media.height, media.width] : [media.width, media.height]
  const columns = Math.max(10, Math.floor((width - 2 * MARGIN) / CHAR_WIDTH))
  const rows = Math.max(5, Math.floor((height - 2 * MARGIN) / LEADING))
  return layout(decode(await source.read(0, source.size)), columns, rows)
}

function decode(bytes: Uint8Array): string {
  const even = bytes.subarray(0, bytes.length & ~1)
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) return new TextDecoder().decode(bytes)
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder('utf-16le').decode(even)
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder('utf-16be').decode(even)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return latin1(bytes)
  }
}

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((b, i) => bytes[i] === b)

function layout(text: string, columns: number, rows: number): number {
  let pages = 0
  let lines = 0
  const newPage = () => {
    pages++
    lines = 0
  }
  const push = (count: number) => {
    for (let i = 0; i < count; i++) {
      if (lines === rows) newPage()
      lines++
    }
  }
  for (const line of (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')) {
    const parts = line.split('\f')
    parts.forEach((part, i) => {
      if (i > 0) newPage()
      if (part || parts.length === 1) push(rowsOf(expand(part), columns))
    })
  }
  if (lines > 0 || pages === 0) newPage()
  return pages
}

/** One UTF-16 unit per character, with spaces kept and tabs expanded, so lengths and break points match the client's. */
function expand(part: string): string {
  let out = ''
  for (const ch of part) {
    if (ch === '\t') out += ' '.repeat(TAB - (out.length % TAB))
    else if (ch !== '\r') out += ch === ' ' ? ' ' : 'x'
  }
  return out
}

/** Breaks at the last space that fits, else mid-word. */
function rowsOf(line: string, columns: number): number {
  let rows = 1
  for (let start = 0; line.length - start > columns; rows++) {
    const space = line.lastIndexOf(' ', start + columns)
    start = space > start ? space + 1 : start + columns
  }
  return rows
}
