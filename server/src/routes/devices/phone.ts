import type { Client } from '@shared/types'
import { timeAgo } from '@/lib/format'
import { clientStatus, type StatusWords } from '@/lib/words'

/** The iPhone app prints to the workspace's printers but never connects printers or stays connected. */
export const isPhone = (client: Pick<Client, 'os'>): boolean => client.os === 'ios'

/** A phone is offline nearly all the time, so it shows when it was last used instead of a worrying "Offline". */
export function deviceStatus(client: Client): StatusWords {
  if (!isPhone(client)) return clientStatus(client)
  return { label: client.lastSeenAt ? `Last used ${timeAgo(client.lastSeenAt)}` : 'Not used yet', tone: 'neutral' }
}
