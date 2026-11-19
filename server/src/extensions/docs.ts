import type { ExtensionInfo } from '@shared/extensions'
import { DOC_PAGES, docHref } from '@/docs/nav'

const REPO = 'https://github.com/yannelli/print-better/blob/master/'

/** The extension's page on the docs site, or its doc in the repository while the site has none. */
export function extensionDocsHref(extension: Pick<ExtensionInfo, 'id' | 'docs'>): string {
  const slug = `extensions/${extension.id}`
  return DOC_PAGES.some((page) => page.slug === slug) ? docHref(slug) : `${REPO}${extension.docs}`
}
