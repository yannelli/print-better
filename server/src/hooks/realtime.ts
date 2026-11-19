import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { connectEvents, liveStatus } from '@/lib/realtime'

export function useRealtime(ws: string) {
  const qc = useQueryClient()
  useEffect(() => connectEvents(qc, ws), [qc, ws])
}

export function useLiveStatus() {
  return useSyncExternalStore(liveStatus.subscribe, liveStatus.get)
}
