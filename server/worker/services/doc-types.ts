import { DOC_TYPES, type DocType } from '../../shared/printing'

const BY_EXTENSION: Record<string, DocType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  txt: 'text/plain',
}

const ALIASES: Record<string, DocType> = { 'application/x-pdf': 'application/pdf', 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' }

const EXTENSION_OF: Record<DocType, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt' }

/** A file name that says nothing about the document, e.g. "document.pdf". */
export const genericFileName = (contentType: string): string => `document.${isDocType(contentType) ? EXTENSION_OF[contentType] : 'bin'}`

export const isDocType = (t: string): t is DocType => (DOC_TYPES as readonly string[]).includes(t)

/** Maps a declared MIME type (or, for generic/missing ones, the file extension) to an accepted document type. */
export function docType(contentType: string | null | undefined, fileName?: string | null): DocType | null {
  const base = contentType?.split(';')[0].trim().toLowerCase() ?? ''
  const mapped = ALIASES[base] ?? base
  if (isDocType(mapped)) return mapped
  if (base === '' || base === 'application/octet-stream' || base === 'binary/octet-stream') {
    const ext = fileName?.split(/[?#]/)[0].split('.').pop()?.toLowerCase()
    return ext ? (BY_EXTENSION[ext] ?? null) : null
  }
  return null
}
