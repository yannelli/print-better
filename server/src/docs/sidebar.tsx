import { Link } from 'wouter'
import { cn } from '@/lib/utils'
import { DOC_SECTIONS, docHref } from './nav'

export function DocsSidebar({ currentSlug, onNavigate }: { currentSlug: string | null; onNavigate?: () => void }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-6 text-sm">
      {DOC_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-1.5 px-3 font-semibold">{section.title}</p>
          <ul className="flex flex-col gap-0.5">
            {section.pages.map((page) => {
              const active = page.slug === currentSlug
              return (
                <li key={page.slug}>
                  <Link
                    href={docHref(page.slug)}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-9 items-center rounded-full px-3 py-1.5 leading-5 transition-colors',
                      active ? 'bg-brand-container font-medium text-on-brand-container' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {page.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
