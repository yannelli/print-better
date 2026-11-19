import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { blobSource, countPages, type TextPaper } from '@shared/pages'
import type { DocType } from '@shared/types'

const ids = new WeakMap<File, number>()
let lastId = 0
function fileId(file: File): number {
  let id = ids.get(file)
  if (id === undefined) ids.set(file, (id = ++lastId))
  return id
}

/** Pages in the chosen document, counted in the browser for previews only; the server counts the real job again. */
export function useDocumentPages(document: File | null, contentType: DocType | null, paper: TextPaper) {
  return useQuery({
    queryKey: ['document-pages', document && fileId(document), contentType, contentType === 'text/plain' ? paper : null],
    queryFn: () => countPages(blobSource(document!), contentType!, paper),
    enabled: document !== null && contentType !== null,
    staleTime: Infinity,
  })
}

/** `value` once it has stopped changing for `ms`, so typing and clicking don't send a request each time. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  const key = JSON.stringify(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
    // `key` stands in for `value`, which is a new object on every render.
  }, [key, ms])
  return settled
}
