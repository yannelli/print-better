import type { Group } from '@shared/access'
import type { NameOf } from '@shared/policy-text'
import type { Client, Member, Printer } from '@shared/types'

export interface PolicySources {
  members: readonly Member[]
  clients: readonly Client[]
  groups: readonly Group[]
  printers: readonly Printer[]
}

/** Names for the ids in rules and limits; something deleted since reads as such, never as an id. */
export const namesFrom =
  (s: PolicySources): NameOf =>
  (kind, id) => {
    switch (kind) {
      case 'user':
        return s.members.find((m) => m.userId === id)?.name ?? 'a former member'
      case 'group':
        return s.groups.find((g) => g.id === id)?.name ?? 'a deleted group'
      case 'client':
        return s.clients.find((c) => c.id === id)?.name ?? 'a removed device'
      case 'printer':
        return s.printers.find((p) => p.id === id)?.name ?? 'a removed printer'
    }
  }

export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
