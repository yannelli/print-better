import { describe, expect, it } from 'vitest'
import { extensionDocsHref } from '@/extensions/docs'
import { pageFile, pageFiles } from './content-index'
import { DOC_PAGES, docHref, findDocPage } from './nav'

const slugs = DOC_PAGES.map((page) => page.slug)

describe('docs nav', () => {
  it('lists each slug once, in a URL-safe form', () => {
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(/^([a-z0-9-]+(\/[a-z0-9-]+)*)?$/)
  })

  it('gives every page a title and a description without dashes', () => {
    for (const page of DOC_PAGES) {
      expect(page.title.trim()).not.toBe('')
      expect(page.description).toMatch(/\.$/)
      expect(`${page.title} ${page.description}`).not.toMatch(/[–—]/)
    }
  })

  it('maps every slug to its own chunk loader key', () => {
    const files = slugs.map(pageFile)
    expect(new Set(files).size).toBe(slugs.length)
    expect(pageFile('')).toBe('./content/index.mdx')
    expect(pageFile('devices/macos')).toBe('./content/devices/macos.mdx')
  })

  it('has a chunk loader only for pages in nav, including the introduction', () => {
    const files = new Set(slugs.map(pageFile))
    expect(pageFiles()).toContain('./content/index.mdx')
    for (const file of pageFiles()) expect(files.has(file), `${file} is not listed in nav.ts`).toBe(true)
  })

  it('finds pages by path and links back to them', () => {
    expect(findDocPage('/docs')?.title).toBe('Introduction')
    expect(findDocPage('/docs/')?.slug).toBe('')
    expect(findDocPage('/docs/printers/add/')?.slug).toBe('printers/add')
    expect(findDocPage('/docs/nope')).toBeUndefined()
    for (const page of DOC_PAGES) expect(findDocPage(docHref(page.slug))).toBe(page)
  })

  it('sends extension links to the docs site when it has the page', () => {
    expect(extensionDocsHref({ id: 'printer-access', docs: 'docs/printer-access.md' })).toBe('/docs/extensions/printer-access')
    const other = { id: 'not-on-the-site' as 'printer-access', docs: 'docs/other.md' }
    expect(extensionDocsHref(other)).toBe('https://github.com/yannelli/print-better/blob/master/docs/other.md')
  })
})
