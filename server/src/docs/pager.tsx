import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Link } from 'wouter'
import { DOC_PAGES, docHref } from './nav'

const cardClass = 'press flex flex-col gap-1 rounded-3xl border bg-card p-5 hover:bg-muted/60'

export function Pager({ slug }: { slug: string }) {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug)
  const previous = DOC_PAGES[index - 1]
  const next = DOC_PAGES[index + 1]
  return (
    <nav aria-label="Previous and next page" className="mt-14 grid gap-3 border-t pt-6 sm:grid-cols-2">
      {previous ? (
        <Link href={docHref(previous.slug)} className={cardClass}>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ArrowLeft className="size-4" aria-hidden /> Previous
          </span>
          <span className="font-medium">{previous.title}</span>
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next && (
        <Link href={docHref(next.slug)} className={`${cardClass} items-end text-right`}>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Next <ArrowRight className="size-4" aria-hidden />
          </span>
          <span className="font-medium">{next.title}</span>
        </Link>
      )}
    </nav>
  )
}
