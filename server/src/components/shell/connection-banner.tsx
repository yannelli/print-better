import { WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLiveStatus } from '@/hooks/realtime'

const GRACE_MS = 4000

/** Shown only when live updates have been down past a short grace period, so quick reconnects stay invisible. */
export function ConnectionBanner() {
  const status = useLiveStatus()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (status !== 'retrying') return setVisible(false)
    const t = setTimeout(() => setVisible(true), GRACE_MS)
    return () => clearTimeout(t)
  }, [status])
  if (!visible) return null
  return (
    <div role="status" className="flex items-center justify-center gap-3 bg-warn-container px-4 py-2.5 text-[0.9375rem] text-on-warn-container">
      <WifiOff className="size-4 shrink-0" />
      <span>
        {navigator.onLine ? 'Live updates paused. Reconnecting…' : "You're offline. We'll reconnect when the internet is back."}
      </span>
    </div>
  )
}
