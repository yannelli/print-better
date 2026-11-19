import type { QueryClient } from '@tanstack/react-query'
import { PING, PING_INTERVAL_MS, PONG, type UiEvent } from '@shared/protocol'
import { eventsUrl } from './api/workspaces'
import { dropClient, dropPrinter, putClient, putJob, putPrinter, putWorkspace } from './cache'
import { qk } from './query'

export type LiveStatus = 'connecting' | 'live' | 'retrying' | 'off'

let status: LiveStatus = 'off'
const listeners = new Set<() => void>()

function setStatus(next: LiveStatus) {
  if (next === status) return
  status = next
  listeners.forEach((fn) => fn())
}

export const liveStatus = {
  get: () => status,
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

export function applyEvent(qc: QueryClient, ws: string, event: UiEvent) {
  switch (event.type) {
    case 'printer':
      return putPrinter(qc, ws, event.printer)
    case 'printer_removed':
      return dropPrinter(qc, ws, event.id)
    case 'job':
      return putJob(qc, ws, event.job)
    case 'client':
      return putClient(qc, ws, event.client)
    case 'client_removed':
      return dropClient(qc, ws, event.id)
    case 'workspace':
      return putWorkspace(qc, event.workspace)
  }
}

const SILENCE_LIMIT_MS = PING_INTERVAL_MS * 2.5
const MAX_BACKOFF_MS = 30_000

/** Keeps one event socket open for a workspace; returns a function that closes it for good. */
export function connectEvents(qc: QueryClient, ws: string): () => void {
  let socket: WebSocket | null = null
  let attempt = 0
  let stopped = false
  let wasLive = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let lastHeard = 0

  const open = () => {
    clearTimeout(retryTimer)
    if (stopped) return
    if (!navigator.onLine) return setStatus('retrying')
    setStatus(attempt === 0 ? 'connecting' : 'retrying')
    const ws_ = new WebSocket(eventsUrl(ws))
    socket = ws_
    ws_.onopen = () => {
      lastHeard = Date.now()
      // Anything could have changed while we were away; refetch what is on screen.
      if (wasLive || attempt > 0) qc.invalidateQueries({ queryKey: qk.ws(ws) })
      attempt = 0
      wasLive = true
      setStatus('live')
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > SILENCE_LIMIT_MS) return ws_.close()
        if (ws_.readyState === WebSocket.OPEN) ws_.send(PING)
      }, PING_INTERVAL_MS)
    }
    ws_.onmessage = (msg) => {
      lastHeard = Date.now()
      if (typeof msg.data !== 'string' || msg.data === PONG) return
      try {
        applyEvent(qc, ws, JSON.parse(msg.data) as UiEvent)
      } catch {
        // Ignore malformed frames rather than tearing down a healthy socket.
      }
    }
    ws_.onclose = () => {
      clearInterval(pingTimer)
      if (socket !== ws_ || stopped) return
      socket = null
      scheduleRetry()
    }
  }

  const scheduleRetry = () => {
    setStatus('retrying')
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6)
    attempt += 1
    retryTimer = setTimeout(open, delay)
  }

  const reconnectNow = () => {
    if (stopped || socket) return
    attempt = Math.max(attempt, 1)
    open()
  }
  const onVisible = () => document.visibilityState === 'visible' && reconnectNow()

  window.addEventListener('online', reconnectNow)
  document.addEventListener('visibilitychange', onVisible)
  open()

  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(pingTimer)
    window.removeEventListener('online', reconnectNow)
    document.removeEventListener('visibilitychange', onVisible)
    socket?.close()
    socket = null
    setStatus('off')
  }
}
