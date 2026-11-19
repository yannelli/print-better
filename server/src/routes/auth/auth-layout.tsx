import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { useInstance } from '@/hooks/auth'
import { cn } from '@/lib/utils'

/** Centered single-task screen used by every signed-out and onboarding page. */
export function AuthLayout({
  title,
  description,
  children,
  footer,
  aside,
  wide,
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Content above the title inside the card, e.g. a step indicator. */
  aside?: ReactNode
  wide?: boolean
}) {
  const appName = useInstance().data?.appName ?? 'Print Better'
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <main id="main" className={cn('mx-auto flex w-full flex-1 flex-col justify-center gap-8 px-5 py-10 sm:py-16', wide ? 'max-w-xl' : 'max-w-md')}>
        <div className="flex items-center gap-3 self-center">
          <Logo className="size-9" />
          <span className="text-lg font-semibold tracking-tight">{appName}</span>
        </div>
        <div className="flex flex-col gap-7 rounded-3xl border bg-card p-6 sm:p-8">
          {aside}
          <header className="flex flex-col gap-2">
            <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.025em] text-balance">{title}</h1>
            {description && <p className="text-base text-muted-foreground">{description}</p>}
          </header>
          {children}
        </div>
        {footer && <div className="flex flex-col items-center gap-3 text-center text-[0.9375rem] text-muted-foreground">{footer}</div>}
      </main>
    </div>
  )
}

/** Inline, announced error for a whole form. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl bg-bad-container px-4 py-3 text-[0.9375rem] text-on-bad-container">
      <CircleAlert className="mt-0.5 size-5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export const linkClass = 'font-medium text-foreground underline underline-offset-4 hover:text-primary'
