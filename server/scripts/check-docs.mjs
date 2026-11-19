#!/usr/bin/env node
// Checks the docs site: nav.ts and the MDX files match, pages compile, and components, code blocks, and links are valid.
// Usage: pnpm check:docs [--allow-missing] [path under src/docs/content, e.g. printers]
import { compile } from '@mdx-js/mdx'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTENT = join(ROOT, 'src/docs/content')
const NAV = join(ROOT, 'src/docs/nav.ts')
const APP_LINKS = join(ROOT, 'src/lib/app-links.ts')
const COMPONENTS = new Set(['Callout', 'Steps', 'Tabs', 'Tab', 'Cards', 'Card', 'PermissionTable', 'RoleTable'])
const LANGS = new Set(['sh', 'bash', 'powershell', 'json', 'jsonc', 'ts', 'tsx', 'js', 'http', 'yaml', 'text', 'ini', 'toml', 'rust', 'html', 'diff', 'python'])
const CALLOUT_TYPES = new Set(['note', 'tip', 'warning'])

const args = process.argv.slice(2)
const allowMissing = args.includes('--allow-missing')
const only = args.find((arg) => !arg.startsWith('--'))

const navSource = readFileSync(NAV, 'utf8')
const slugs = [...navSource.matchAll(/slug: '([^']*)'/g)].map((match) => match[1])
const appList = (name) => [...(new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(readFileSync(APP_LINKS, 'utf8'))?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
const workspaceFree = new Set([...appList('WORKSPACE_FREE_PATHS'), ...appList('SETTINGS_TABS').map((tab) => `/settings/${tab}`)])
const accountPaths = appList('ACCOUNT_PATHS')
const isAppPath = (path) => path === '/' || workspaceFree.has(path.replace(/\/$/, '')) || accountPaths.some((p) => path === p || path.startsWith(`${p}/`))
const fileFor = (slug) => join(CONTENT, `${slug || 'index'}.mdx`)
const show = (path) => relative(ROOT, path)

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.mdx') ? [path] : []
  })
}

function visit(node, fn) {
  fn(node)
  for (const child of node.children ?? []) visit(child, fn)
}

const errors = []
const missing = []
const pages = new Map()
const files = walk(CONTENT)
const expected = new Set(slugs.map(fileFor))

for (const slug of new Set(slugs.filter((slug, index) => slugs.indexOf(slug) !== index))) errors.push(`${show(NAV)}: slug "${slug}" is listed more than once`)
for (const [index, line] of navSource.split('\n').entries()) if (/[–—]/.test(line)) errors.push(`${show(NAV)}: line ${index + 1}: em or en dash`)
for (const slug of slugs) if (!files.includes(fileFor(slug))) (allowMissing ? missing : errors).push(`${show(fileFor(slug))}: missing (listed in nav.ts)`)
for (const file of files) if (!expected.has(file)) errors.push(`${show(file)}: not listed in nav.ts`)

for (const file of files.filter((path) => expected.has(path))) {
  const source = readFileSync(file, 'utf8')
  const prose = source.replace(/```[\s\S]*?```/g, '')
  const page = { ids: new Set(), links: [] }
  const report = (message) => errors.push(`${show(file)}: ${message}`)
  if (/^#\s/m.test(prose)) report('uses a # heading. The page title comes from nav.ts; start sections at ##.')
  if (/^---\s*$/m.test(source.split('\n')[0])) report('has frontmatter. The title and description come from nav.ts.')
  if (/^(import|export)\s/m.test(prose)) report('uses import or export. Components need no import, and the title comes from nav.ts.')
  for (const [index, line] of source.split('\n').entries()) if (/[–—]/.test(line)) report(`line ${index + 1}: em or en dash`)
  const collect = () => (tree) =>
    visit(tree, (node) => {
      if (node.type === 'code' && !LANGS.has(node.lang ?? '')) report(`line ${node.position?.start.line}: code block language "${node.lang ?? ''}" is missing or not allowed`)
      if (node.type === 'link') page.links.push(node.url)
      if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
        const attrs = Object.fromEntries((node.attributes ?? []).map((attr) => [attr.name, typeof attr.value === 'string' ? attr.value : null]))
        if (!COMPONENTS.has(node.name)) report(`line ${node.position?.start.line}: unknown component <${node.name}>`)
        if (node.name === 'Card' && attrs.href) page.links.push(attrs.href)
        if (node.name === 'Card' && (!attrs.href || !attrs.title)) report('<Card> needs href and title')
        if (node.name === 'Callout' && attrs.type && !CALLOUT_TYPES.has(attrs.type)) report(`<Callout type="${attrs.type}"> is not note, tip, or warning`)
        if (node.name === 'Tab' && !attrs.label) report('<Tab> needs a label')
      }
    })
  const ids = () => (tree) => visit(tree, (node) => node.type === 'element' && node.properties?.id && page.ids.add(String(node.properties.id)))
  try {
    await compile(source, { remarkPlugins: [remarkGfm, collect], rehypePlugins: [rehypeSlug, ids] })
  } catch (error) {
    report(`does not compile: ${error.message}`)
  }
  pages.set(slugs.find((slug) => fileFor(slug) === file), { ...page, file })
}

for (const [slug, page] of pages) {
  const report = (message) => errors.push(`${show(page.file)}: ${message}`)
  for (const link of page.links) {
    if (/^(https?:|mailto:)/.test(link)) continue
    const [path, hash] = link.split('#')
    if (!path) {
      if (!page.ids.has(hash)) report(`link #${hash} has no matching heading on this page`)
      continue
    }
    if (!path.startsWith('/docs')) {
      if (!isAppPath(path)) report(`link ${link} is not a docs page or an app screen (${[...workspaceFree, ...accountPaths].join(', ')})`)
      continue
    }
    const target = path.replace(/^\/docs\/?/, '').replace(/\/$/, '')
    if (!slugs.includes(target)) {
      report(`link ${link} does not match a page in nav.ts`)
      continue
    }
    if (hash && pages.has(target) && !pages.get(target).ids.has(hash)) report(`link ${link} has no heading #${hash} on ${slug === target ? 'this page' : target || 'index'}`)
  }
}

const scope = only ? join(CONTENT, only) : null
const inScope = (message) => !scope || message.startsWith(show(scope))
const shown = errors.filter(inScope)
const skipped = missing.filter(inScope)
if (skipped.length) console.warn(`Skipped ${skipped.length} page(s) listed in nav.ts without a file (--allow-missing).`)
if (shown.length) {
  console.error(shown.map((error) => `- ${error}`).join('\n'))
  console.error(`\n${shown.length} problem(s) in ${show(CONTENT)}`)
  process.exit(1)
}
console.log(`Docs OK: ${pages.size} pages, ${[...pages.values()].reduce((sum, page) => sum + page.links.length, 0)} links checked.`)
