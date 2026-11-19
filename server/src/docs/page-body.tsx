import type { MDXContent } from 'mdx/types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocationProperty } from 'wouter/use-browser-location'
import { Skeleton } from '@/components/ui/skeleton'
import { mdxComponents } from './components/mdx'
import { loadPage } from './content-index'
import { readToc, type TocItem } from './toc'

type Loaded = { slug: string; Content: MDXContent } | { slug: string; failed: true }

const useHash = () => useLocationProperty(() => location.hash)

export function PageBody({ slug, onToc }: { slug: string; onToc: (items: TocItem[]) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const article = useRef<HTMLElement>(null)
  const hash = useHash()

  useEffect(() => {
    let current = true
    const failed = () => current && setLoaded({ slug, failed: true })
    const load = loadPage(slug)
    if (!load) failed()
    load?.then((module) => current && setLoaded({ slug, Content: module.default })).catch(failed)
    return () => {
      current = false
    }
  }, [slug])

  const ready = loaded?.slug === slug && 'Content' in loaded ? loaded : null

  useLayoutEffect(() => {
    if (ready && article.current) onToc(readToc(article.current))
  }, [ready, onToc])

  // Scrolls once the content exists, so the target is in place and nothing below shifts it.
  useLayoutEffect(() => {
    if (!ready) return
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)))
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [ready, hash])

  if (loaded?.slug === slug && 'failed' in loaded) {
    return <p className="text-muted-foreground">This page did not load. Reload the page to try again.</p>
  }
  if (!ready) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading page">
        <Skeleton className="h-5 w-11/12" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    )
  }
  return (
    <article ref={article} className="docs-prose">
      <ready.Content components={mdxComponents} />
    </article>
  )
}
