// Page counts for documents (docs/usage.md, "Page counting"), on the server and in the browser.

import type { DocType } from '../printing'
import type { ByteSource } from '../usage'
import { countPdf } from './pdf-count'
import { countText, type TextPaper } from './text'

export { blobSource, bytesSource } from './sources'
export type { TextPaper } from './text'

/** Pages in the document before page ranges and copies; null when they can't be counted. Never throws. */
export async function countPages(source: ByteSource, contentType: DocType, paper?: TextPaper): Promise<number | null> {
  try {
    if (contentType === 'application/pdf') return await countPdf(source)
    if (contentType === 'text/plain') return await countText(source, paper)
    return contentType === 'image/jpeg' || contentType === 'image/png' ? 1 : null
  } catch {
    return null
  }
}
