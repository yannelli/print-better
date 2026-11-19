import { Lock, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A row-shaped note inside a flush Section. */
export function Note({ tone, children }: { tone: 'neutral' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Lock
  const color = tone === 'warn' ? 'text-on-warn-container' : 'text-muted-foreground'
  return (
    <div className={cn('flex gap-3 border-b px-5 py-4 text-[0.9375rem] last:border-b-0 sm:px-6', tone === 'warn' && 'bg-warn-container')}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', color)} />
      <p className={color}>{children}</p>
    </div>
  )
}

export const LAN_SHARE_WARNING =
  'This printer is restricted, but it is also shared on the local network. Anyone on that network can still print to it without signing in.'
