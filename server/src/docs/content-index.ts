import type { MDXContent } from 'mdx/types'
import { DOC_PAGES, type DocEntry } from './nav'

type PageModule = { default: MDXContent }

const pages = import.meta.glob<PageModule>('./content/**/*.mdx')
const sources = import.meta.glob<string>('./content/**/*.mdx', { query: '?raw', import: 'default' })

export const pageFile = (slug: string) => `./content/${slug || 'index'}.mdx`

/** Content files that have a chunk. */
export const pageFiles = () => Object.keys(pages)

export function loadPage(slug: string): Promise<PageModule> | null {
  return pages[pageFile(slug)]?.() ?? null
}

export function loadSource(slug: string): Promise<string> | null {
  return sources[pageFile(slug)]?.() ?? null
}

/** Same rules as github-slugger, which rehype-slug uses for heading ids. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/ /g, '-')
}

export function plainMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\|/g, ' ')
    .trim()
}

export interface SearchEntry {
  page: DocEntry
  heading: { text: string; id: string } | null
  text: string
}

/** Splits each page into one entry per section so results can link to the matching heading. */
export function searchEntries(page: DocEntry, source: string): SearchEntry[] {
  const entries: SearchEntry[] = []
  let current: SearchEntry = { page, heading: null, text: page.description }
  const seen = new Map<string, number>()
  const prose = source.replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[A-Z][^>]*>/g, ' ')
  for (const line of prose.split('\n')) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line)
    if (heading) {
      entries.push(current)
      const text = plainMarkdown(heading[1]!)
      const base = headingId(text)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      current = { page, heading: { text, id: count ? `${base}-${count}` : base }, text: '' }
    } else if (!/^\s*\|?\s*:?-{3,}/.test(line)) {
      current.text += ` ${plainMarkdown(line)}`
    }
  }
  entries.push(current)
  return entries.map((entry) => ({ ...entry, text: entry.text.replace(/\s+/g, ' ').trim() }))
}

export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const loaded = await Promise.all(DOC_PAGES.map(async (page) => ({ page, source: (await loadSource(page.slug)) ?? '' })))
  return loaded.flatMap(({ page, source }) => searchEntries(page, source))
}
