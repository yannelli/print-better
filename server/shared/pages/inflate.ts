import { concat } from './bytes'
import type { Budget } from './reader'

const isTrailingSpace = (c: number) => c === 0x0a || c === 0x0d || c === 0x20

/** zlib data inflated within the budget, stopping as soon as the output passes what is left of it. */
export async function inflate(data: Uint8Array, budget: Budget): Promise<Uint8Array> {
  let end = data.length
  while (end > 0 && isTrailingSpace(data[end - 1])) end--
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  writer
    .write(data.slice(0, end))
    .then(() => writer.close())
    .catch(() => {})
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      total += result.value.length
      if (total > budget.inflateLeft) throw new Error('inflate budget exceeded')
      chunks.push(result.value)
    }
  } catch (e) {
    reader.cancel().catch(() => {})
    // Trimming the end-of-line some writers count in /Length can cut a checksum byte; the data before it is whole.
    if (total > budget.inflateLeft || total === 0) throw e
  }
  budget.inflated += total
  return concat(chunks)
}
