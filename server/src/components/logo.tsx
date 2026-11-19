import { cn } from '@/lib/utils'

/** The mark: a sheet with a folded corner on an ink tile. Mirrors public/favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8 shrink-0 text-foreground', className)}>
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path d="M10 7h8.6L23 11.4V24a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" className="fill-background" />
      <path d="M18.4 7v3.6a1 1 0 0 0 1 1H23" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12.5 16.5h7M12.5 20h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
