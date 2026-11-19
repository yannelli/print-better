import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useCopy } from '@/components/copy'
import { Button } from '@/components/ui/button'
import { loadSource } from './content-index'
import { DocsHeader } from './header'
import { findDocPage } from './nav'
import { withOrigin } from './origin'
import { PageBody } from './page-body'
import { Pager } from './pager'
import { SearchDialog, useSearchShortcut } from './search'
import { DocsSidebar } from './sidebar'
import { Toc, type TocItem } from './toc'
import './docs.css'

function CopyPage({ slug }: { slug: string }) {
  const { copied, copy } = useCopy()
  const Icon = copied ? Check : Copy
  return (
    <Button variant="outline" size="sm" onClick={() => void loadSource(slug)?.then((source) => copy(withOrigin(source)))}>
      <Icon data-icon="inline-start" className={copied ? 'text-ok' : undefined} />
      {copied ? 'Copied' : 'Copy page as Markdown'}
    </Button>
  )
}

function PageNotFound({ onSearch }: { onSearch: () => void }) {
  return (
    <>
      <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.025em] sm:text-4xl">Page not found</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        This page doesn’t exist. Go to the{' '}
        <Link href="/docs" className="font-medium text-foreground underline underline-offset-4">
          docs home
        </Link>{' '}
        or search the docs.
      </p>
      <Button variant="outline" className="mt-6" onClick={onSearch}>
        Search the docs
      </Button>
    </>
  )
}

export default function DocsApp() {
  const [path] = useLocation()
  const page = findDocPage(path)
  const [search, setSearch] = useState(false)
  const [toc, setToc] = useState<TocItem[]>([])
  const openSearch = useCallback(() => setSearch(true), [])
  useSearchShortcut(openSearch)

  useEffect(() => {
    document.title = page ? `${page.title} · Print Better docs` : 'Page not found · Print Better docs'
    setToc([])
    if (!location.hash) window.scrollTo(0, 0)
    return () => {
      document.title = 'Print Better'
    }
  }, [page])

  return (
    <div className="min-h-dvh">
      <DocsHeader slug={page?.slug ?? null} onSearch={openSearch} />
      <div className="mx-auto max-w-[88rem] px-5 sm:px-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[15rem_minmax(0,1fr)_14rem]">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto py-8 pr-1 lg:block">
          <DocsSidebar currentSlug={page?.slug ?? null} />
        </aside>

        <main id="main" className="min-w-0 pt-8 pb-16 lg:pt-10">
          <div className="mx-auto max-w-[46rem]">
            {page ? (
              <>
                <p className="mb-2 text-sm font-medium text-muted-foreground">{page.section}</p>
                <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-4xl">{page.title}</h1>
                <p className="mt-3 text-lg leading-7 text-pretty text-muted-foreground">{page.description}</p>
                <div className="mt-5">
                  <CopyPage slug={page.slug} />
                </div>
                {toc.length > 0 && (
                  <details className="mt-6 rounded-2xl border px-4 py-3 xl:hidden">
                    <summary className="cursor-pointer text-sm font-medium">On this page</summary>
                    <div className="mt-2">
                      <Toc items={toc} showTitle={false} />
                    </div>
                  </details>
                )}
                <div className="mt-8">
                  <PageBody key={page.slug} slug={page.slug} onToc={setToc} />
                </div>
                <Pager slug={page.slug} />
              </>
            ) : (
              <PageNotFound onSearch={openSearch} />
            )}
          </div>
        </main>

        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto py-10 xl:block">
          <Toc items={toc} />
        </aside>
      </div>
      <SearchDialog open={search} onOpenChange={setSearch} />
    </div>
  )
}
