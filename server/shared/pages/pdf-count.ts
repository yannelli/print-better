import type { ByteSource } from '../usage'
import { Objects } from './pdf-objects'
import { SCAN_BYTES, SCAN_READS, scanCount } from './pdf-scan'
import { pageCount } from './pdf-values'
import { loadXref } from './pdf-xref'
import { Budget, MAX_READ_BYTES, MAX_READS, Reader } from './reader'

/** The page tree root's `/Count`, found through the cross-reference table, else by a bounded scan. */
export async function countPdf(source: ByteSource): Promise<number | null> {
  const budget = new Budget(MAX_READS - SCAN_READS, MAX_READ_BYTES - SCAN_BYTES)
  const reader = new Reader(source, budget)
  const count = await treeCount(reader).catch(() => null)
  if (count !== null) return count
  budget.maxReads = MAX_READS
  budget.maxBytes = MAX_READ_BYTES
  return scanCount(reader).catch(() => null)
}

async function treeCount(reader: Reader): Promise<number | null> {
  const xref = await loadXref(reader)
  const objects = new Objects(reader, xref)
  const catalog = await objects.resolve(xref.root)
  const tree = catalog instanceof Map ? await objects.resolve(catalog.get('Pages')) : undefined
  return tree instanceof Map ? pageCount(await objects.resolve(tree.get('Count'))) : null
}
