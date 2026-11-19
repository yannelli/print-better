import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { DOC_TYPES, type DocType, type Job, type JobOptions } from '@shared/types'
import { jobsApi, uploadJobFile } from '@/lib/api/jobs'
import { putJob } from '@/lib/cache'

export type PrintSource = { kind: 'file'; file: File } | { kind: 'text'; text: string }

export interface PrintInput {
  printerId: string
  options: JobOptions
  source: PrintSource
  /** Request fields extensions add in the print dialog, such as `costCenter`. */
  extra?: Readonly<Record<string, unknown>>
}

const EXTENSIONS: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', txt: 'text/plain' }

/** Browsers leave `File.type` empty for some files, so fall back to the extension. */
export function fileContentType(file: File): DocType | null {
  const type = file.type || EXTENSIONS[file.name.split('.').pop()?.toLowerCase() ?? ''] || ''
  return (DOC_TYPES as readonly string[]).includes(type) ? (type as DocType) : null
}

function textTitle(text: string) {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Text'
}

/** Creates the job, then streams the file with progress. Cancel aborts the upload and the job. */
export function usePrintSubmit(ws: string) {
  const qc = useQueryClient()
  const [progress, setProgress] = useState<number | null>(null)
  const abort = useRef<AbortController | null>(null)

  const mutation = useMutation({
    mutationFn: async ({ printerId, options, source, extra }: PrintInput): Promise<Job> => {
      if (source.kind === 'text') {
        const { job } = await jobsApi.createText(ws, { ...extra, printerId, options, title: textTitle(source.text), text: source.text })
        return job
      }
      const contentType = fileContentType(source.file) ?? 'application/octet-stream'
      const { job, uploadUrl } = await jobsApi.createUpload(ws, {
        ...extra,
        printerId,
        options,
        title: source.file.name,
        upload: { fileName: source.file.name, contentType, size: source.file.size },
      })
      putJob(qc, ws, job)
      const controller = new AbortController()
      abort.current = controller
      setProgress(0)
      try {
        const done = await uploadJobFile(uploadUrl, new File([source.file], source.file.name, { type: contentType }), setProgress, controller.signal)
        return done.job
      } catch (error) {
        if (controller.signal.aborted) jobsApi.cancel(ws, job.id).catch(() => undefined)
        throw error
      }
    },
    onSuccess: (job) => putJob(qc, ws, job),
    onSettled: () => {
      setProgress(null)
      abort.current = null
    },
    meta: { quiet: true },
  })

  return { ...mutation, progress, cancelUpload: () => abort.current?.abort() }
}
