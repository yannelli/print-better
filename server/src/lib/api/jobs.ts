import type { Job, JobOptions } from '@shared/types'
import { enc, http, qs, uploadWithProgress } from './http'
import type { CreatedUpload, JobFilters, Page } from './types'

interface JobBase {
  printerId: string
  title?: string
  options?: JobOptions
}

const base = (ws: string) => `/workspaces/${enc(ws)}/jobs`

export const jobsApi = {
  list: (ws: string, filters: JobFilters & { cursor?: string; limit?: number } = {}) =>
    http.get<Page<Job>>(`${base(ws)}${qs({ ...filters })}`),
  get: (ws: string, id: string) => http.get<Job>(`${base(ws)}/${enc(id)}`),
  createUpload: (ws: string, input: JobBase & { upload: { fileName: string; contentType: string; size: number } }) =>
    http.post<CreatedUpload>(base(ws), input),
  createText: (ws: string, input: JobBase & { text: string }) => http.post<{ job: Job }>(base(ws), input),
  createUrl: (ws: string, input: JobBase & { url: string }) => http.post<{ job: Job }>(base(ws), input),
  cancel: (ws: string, id: string) => http.post<Job>(`${base(ws)}/${enc(id)}/cancel`),
  retry: (ws: string, id: string) => http.post<Job>(`${base(ws)}/${enc(id)}/retry`),
  remove: (ws: string, id: string) => http.del(`${base(ws)}/${enc(id)}`),
}

export const jobFileUrl = (ws: string, id: string) => `/api${base(ws)}/${enc(id)}/file`

/** Step two of an upload: stream the bytes to the URL the server handed back. */
export function uploadJobFile(
  uploadUrl: string,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
) {
  return uploadWithProgress<{ job: Job }>(uploadUrl, file, onProgress, signal)
}
