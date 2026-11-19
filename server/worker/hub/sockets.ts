import type { ServerMessage, UiEvent } from '../../shared/protocol'

/** Headers the Worker sets when forwarding an authenticated upgrade; the hub is unreachable except via the Worker. */
export const HUB_HEADERS = {
  kind: 'X-PB-Kind',
  workspace: 'X-PB-Workspace',
  client: 'X-PB-Client',
  user: 'X-PB-User',
  origin: 'X-PB-Origin',
} as const

export interface ClientAtt {
  kind: 'client'
  workspaceId: string
  clientId: string
  origin: string
  /** Set after a valid `hello`; until then only `hello` is accepted. */
  ready: boolean
  seenAt: number
  /** Fingerprint of the last `remote_printers` snapshot sent on this socket. */
  remotePrinters?: string
}

export interface UiAtt {
  kind: 'ui'
  workspaceId: string
  userId: string
  seenAt: number
}

export type Attachment = ClientAtt | UiAtt

export const CLIENT_TAG = 'client'
export const UI_TAG = 'ui'
export const clientTag = (id: string): string => `client:${id}`
export const userTag = (id: string): string => `user:${id}`

export function attachment(ws: WebSocket): Attachment | null {
  const att = ws.deserializeAttachment() as Attachment | null
  return att?.kind === 'client' || att?.kind === 'ui' ? att : null
}

export function send(ws: WebSocket, msg: ServerMessage | UiEvent): boolean {
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

export const isOpen = (ws: WebSocket): boolean => ws.readyState === WebSocket.OPEN

/** The request the Worker forwards to the hub for an authenticated WebSocket upgrade. */
export function upgradeRequest(url: string, headers: Record<string, string>): Request {
  return new Request(url, { headers: { Upgrade: 'websocket', ...headers } })
}
