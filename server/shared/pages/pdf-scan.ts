import { lastIndexOf, latin1 } from './bytes'
import { Lexer } from './pdf-lexer'
import { isName, pageCount } from './pdf-values'
import type { Reader } from './reader'

const STEP = 1024 * 1024
const OVERLAP = 64 * 1024
export const SCAN_READS = 4
export const SCAN_BYTES = SCAN_READS * (STEP + OVERLAP)

/** Last resort: the page tree root (`/Type /Pages` without `/Parent`) in plain bytes near the end, then near the start. */
export async function scanCount(reader: Reader): Promise<number | null> {
  for (const start of scanStarts(reader.size)) {
    const buf = await reader.bytes(start, STEP + OVERLAP)
    const count = lastRootCount(buf, start + buf.length >= reader.size)
    if (count !== null) return count
  }
  return null
}

/** Windows from the end and from the start in turn, overlapping so an object across a boundary is seen whole. */
function scanStarts(size: number): number[] {
  const starts: number[] = []
  let head = 0
  let tail = size
  while (head < tail && starts.length < SCAN_READS) {
    if (starts.length % 2 === 0) {
      tail = Math.max(head, tail - STEP)
      starts.push(Math.max(0, tail - OVERLAP))
    } else {
      starts.push(head)
      head = Math.min(tail, head + STEP)
    }
  }
  return starts
}

/** The latest root in the window, since incremental updates append newer versions. */
function lastRootCount(buf: Uint8Array, complete: boolean): number | null {
  for (let at = lastIndexOf(buf, '/Pages'); at >= 0; at = lastIndexOf(buf, '/Pages', at - 1)) {
    const count = rootCount(buf, lastIndexOf(buf, 'obj', at - 3), complete)
    if (count !== null) return count
  }
  return null
}

function rootCount(buf: Uint8Array, objAt: number, complete: boolean): number | null {
  const header = /\d+\s+\d+\s+$/.exec(latin1(buf.subarray(Math.max(0, objAt - 24), Math.max(0, objAt))))
  if (objAt < 0 || !header) return null
  try {
    const { value } = new Lexer(buf, objAt - header[0].length, complete).indirect()
    return value instanceof Map && isName(value.get('Type'), 'Pages') && !value.has('Parent') ? pageCount(value.get('Count')) : null
  } catch {
    return null
  }
}
