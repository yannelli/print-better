import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  back,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  back?: { href: string; label: string }
  children?: ReactNode
}) {
  return (
    <header className="mb-8 flex flex-col gap-4">
      {back && (
        <Link
          href={back.href}
          className="press -ml-2 inline-flex h-9 w-fit items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-[1.875rem] leading-tight font-semibold tracking-[-0.025em] text-balance">{title}</h1>
          {description && <p className="max-w-prose text-base text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

/** A titled group of content on a hairline card. Use `flush` for lists that draw their own rows. */
export function Section({
  title,
  description,
  actions,
  flush,
  className,
  children,
  id,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  flush?: boolean
  className?: string
  children: ReactNode
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={id && title ? `${id}-title` : undefined} className={cn('flex flex-col gap-3', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <div className="flex flex-col gap-1">
            {title && (
              <h2 id={id ? `${id}-title` : undefined} className="text-lg font-semibold tracking-tight">
                {title}
              </h2>
            )}
            {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('rounded-3xl border bg-card', flush ? 'overflow-hidden' : 'p-5 sm:p-6')}>{children}</div>
    </section>
  )
}

/** A row inside a Section: label and help on the left, control on the right. */
export function Row({
  label,
  description,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  htmlFor?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[0.9375rem] font-medium">
            {label}
          </label>
        ) : (
          <span className="text-[0.9375rem] font-medium">{label}</span>
        )}
        {description && <span className="text-sm text-muted-foreground">{description}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** Monospace for values people may need to copy or compare: ids, addresses, versions. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[0.875em] tracking-tight', className)}>{children}</span>
}
