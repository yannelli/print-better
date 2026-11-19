import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Job } from '@shared/types'
import { jobsApi } from '@/lib/api/jobs'
import type { JobFilters } from '@/lib/api/types'
import { dropJob, putJob } from '@/lib/cache'
import { qk } from '@/lib/query'

export function useJobs(ws: string, filters: JobFilters = {}) {
  return useInfiniteQuery({
    queryKey: qk.jobs(ws, filters),
    queryFn: ({ pageParam }) => jobsApi.list(ws, { ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((p) => p.items),
  })
}

export function useJob(ws: string, id: string) {
  return useQuery({ queryKey: qk.job(ws, id), queryFn: () => jobsApi.get(ws, id) })
}

export function useJobAction(ws: string, action: 'cancel' | 'retry') {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => jobsApi[action](ws, id),
    onSuccess: (job: Job | undefined) => {
      if (job?.id) putJob(qc, ws, job)
      else qc.invalidateQueries({ queryKey: qk.jobsAll(ws) })
    },
    meta: { success: action === 'cancel' ? 'Print canceled' : 'Trying again' },
  })
}

export function useDeleteJob(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => jobsApi.remove(ws, id),
    onSuccess: (_d, id) => dropJob(qc, ws, id),
    meta: { success: 'Removed from the list' },
  })
}
