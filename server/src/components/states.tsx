import type { LucideIcon } from 'lucide-react'
import { CircleAlert, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/http'
import { cn } from '@/lib/utils'

export function Loading({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3 py-16 text-muted-foreground', className)} role="status">
      <Spinner className="size-5" />
      <span>{label}</span>
    </div>
  )
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 rounded-2xl" />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-start gap-4 rounded-3xl bg-bad-container p-6 text-on-bad-container sm:flex-row sm:items-center', className)}
    >
      <CircleAlert className="size-6 shrink-0" />
      <p className="flex-1 text-base">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="border-current/30 bg-transparent text-current">
          <RotateCw data-icon="inline-start" />
          Try again
        </Button>
      )}
    </div>
  )
}

/** An empty screen is an invitation to act: say what goes here and offer the next step. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-5 rounded-3xl border border-dashed px-6 py-14 text-center', className)}>
      <div className="flex size-16 items-center justify-center rounded-[1.75rem] bg-brand-container text-on-brand-container">
        <Icon className="size-7" />
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-base text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/** Renders loading, error, or the data, so every screen handles all three the same way. */
export function QueryState<T>({
  query,
  loading,
  children,
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }
  loading?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <>{loading ?? <SkeletonRows />}</>
}
