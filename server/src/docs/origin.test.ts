import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN_TOKEN, replaceOrigin, withOrigin } from './origin'

const ORIGIN = 'https://print.example.com'

afterEach(() => vi.unstubAllGlobals())

describe('origin replacement', () => {
  it('replaces every copy of the placeholder in text', () => {
    const text = `curl ${ORIGIN_TOKEN}/api/me\nprintbetter pair --server ${ORIGIN_TOKEN}`
    expect(withOrigin(text, ORIGIN)).toBe(`curl ${ORIGIN}/api/me\nprintbetter pair --server ${ORIGIN}`)
    expect(withOrigin('no address here', ORIGIN)).toBe('no address here')
  })

  it('uses the address the reader is on by default', () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    expect(withOrigin(`${ORIGIN_TOKEN}/mcp`)).toBe(`${ORIGIN}/mcp`)
  })

  it('replaces the placeholder inside highlighted code and inline code', () => {
    const code = h('code', null, h('span', { style: { color: 'red' } }, 'curl '), h('span', null, `${ORIGIN_TOKEN}/api`), '\n')
    const html = renderToStaticMarkup(h('pre', null, replaceOrigin(code, ORIGIN)))
    expect(html).toBe(`<pre><code><span style="color:red">curl </span><span>${ORIGIN}/api</span>\n</code></pre>`)
    expect(renderToStaticMarkup(h('code', null, replaceOrigin(`${ORIGIN_TOKEN}/mcp`, ORIGIN)))).toBe(`<code>${ORIGIN}/mcp</code>`)
  })

  it('leaves elements without text alone', () => {
    const empty = h('br')
    expect(replaceOrigin(empty, ORIGIN)).toBe(empty)
    expect(replaceOrigin(null, ORIGIN)).toBeNull()
  })
})
