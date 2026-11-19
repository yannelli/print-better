import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import mdx from '@mdx-js/rollup'
import rehypeShiki from '@shikijs/rehype'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { defineConfig, type Plugin } from 'vite'

const codeTitle = (meta: string) => {
  const title = /title="([^"]+)"/.exec(meta)?.[1]
  return title ? { 'data-title': title } : undefined
}

const mdxPlugin = mdx({
  remarkPlugins: [remarkGfm],
  rehypePlugins: [
    rehypeSlug,
    [rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, fallbackLanguage: 'text', parseMetaString: codeTitle }],
  ],
}) as Plugin
const compileMdx = mdxPlugin.transform as Extract<Plugin['transform'], (...args: never[]) => unknown>

/** The MDX plugin drops the query from module ids, so `?raw` imports (docs search) would compile too. */
const docsMdx: Plugin = {
  ...mdxPlugin,
  enforce: 'pre',
  transform(code, id, options) {
    return /[?&]raw\b/.test(id) ? null : compileMdx.call(this, code, id, options)
  },
}

export default defineConfig({
  plugins: [docsMdx, react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
    },
  },
})
