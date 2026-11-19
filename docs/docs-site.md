# Writing the Docs Site

Created: 2026-11-19. Last updated: 2026-11-19.

The docs site is part of the web app. Every Print Better server serves it at `/docs`, and readers do not need to sign in. Pages are MDX files compiled at build time.

## Files

| Path | What it holds |
| --- | --- |
| `server/src/docs/nav.ts` | The sidebar. Each page's slug, title, and one-sentence description. The page title and description come from here. |
| `server/src/docs/content/<slug>.mdx` | One page. The `/docs` home page is `content/index.mdx`. `/docs/devices/macos` is `content/devices/macos.mdx`. |
| `server/src/docs/components/` | The components that MDX pages can use. |
| `server/src/lib/app-links.ts` | The app screens that docs pages can link to. |
| `server/scripts/check-docs.mjs` | `pnpm check:docs`. Finds missing pages, unknown components, dashes, code without a language, and broken links. |

To add a page: add it to `nav.ts`, create the MDX file, and run `pnpm --dir server check:docs`.

## Page Shape

- Do not write a `#` heading, frontmatter, or `export const meta`. The site shows the title and description from `nav.ts` above the page.
- Start with the answer or the first action, or go straight to the first section. The description from `nav.ts` already sits above the page, so skip intros that only announce what the page covers.
- Use `##` for sections and `###` for subsections. Both appear in the "On this page" list.
- Use Title Case for page and group titles in `nav.ts`, headings, `<Steps>` step headings, and `title` attributes on `<Callout>` and `<Card>`:
  - Lowercase a, an, the, and, but, or, for, nor, as, at, by, in, of, on, to, up, via, and vs, unless the word comes first or last, or belongs to a phrasal verb (Set Up, Sign In, Turn On): "Set Up Email to Print", "What You Don't Need to Back Up".
  - Code stays exact: `printbetter`, `wrangler.jsonc`.
  - Heading ids stay lowercase, so the case doesn't change anchors.
- Link text that names a page or heading uses its Title Case title: `[Printer Discovery](/docs/devices/discovery)`.
- End task pages with a "Next Steps" section that uses `<Cards>`, when there is an obvious next page.

## Components

Use these without an import.

| Component | Use |
| --- | --- |
| `<Callout type="note">` | A fact the reader must not miss. Types: `note`, `tip`, `warning`. Optional `title="..."`. |
| `<Steps>` | A procedure. Write each step as a `###` heading inside `<Steps>`. The site numbers them. |
| `<Tabs>` with `<Tab label="...">` | The same task done in different ways, for example macOS and Linux, or curl and JavaScript. |
| `<Cards>` with `<Card href="/docs/..." title="...">` | Links to the next pages. Put one sentence inside each card. |
| `<PermissionTable />` | The 6 printer access permissions and what each one allows. |
| `<RoleTable />` | The built-in printer access roles and their permissions. |

The two tables read their data from `server/shared/access.ts` and their wording from `server/src/lib/access-words.ts`, so they always match the app.

Leave a blank line after an opening component tag and before the closing tag, so the Markdown inside renders.

```mdx
<Steps>

### Open the Devices Screen

Select **Devices** in the sidebar.

### Add the Computer

Select **Add a device** and follow the steps.

</Steps>
```

## Code

- Every fenced block needs a language: `sh`, `json`, `jsonc`, `ts`, `js`, `http`, `yaml`, `text`, `ini`, `toml`, `rust`, and a few more (see `LANGS` in `server/scripts/check-docs.mjs`).
- Add a file name with `title`: ```` ```jsonc title="wrangler.jsonc" ````.
- Each block gets a copy button.
- Write the server address as `https://your-print-better.example`. The site replaces it with the address the reader is on, in code blocks and inline code.
- Write API tokens as `$PRINTBETTER_TOKEN` in shell examples.

## Links

- Docs pages: `/docs/printers/add`, with an optional `#heading-id`. Heading ids are the lowercase heading text with dashes, for example `## Text Cap` is `#text-cap`.
- Workspace screens: `/printers`, `/jobs`, `/devices`, `/devices/add`, `/members`, `/settings`. Each one opens that screen in the reader's current or last-used workspace, and sends signed-out readers to sign-in first.
- Account and admin screens: `/account`, `/admin`, `/connect`.
- Other sites: full `https://` URLs. They open in a new tab.

## Writing Rules

- US English. Second person ("you"). Present tense. Active voice. Contractions are fine.
- Terse and structured: headings, lists, tables, and code blocks, with very little prose.
- Lead with the answer or the action. The first sentence of a page or section says what happens or what to do.
- Name buttons, fields, settings, and screens exactly as the app shows them, in bold. Check the strings in `server/src`. Quote commands, paths, and error text exactly.
- Write procedures as numbered steps, one action per step: "Select **Add printer**." Use `<Steps>` for a whole task and a numbered list for a short one.
- Put prerequisites before the first step, under a heading such as "Before You Start" or "Requirements".
- Put an exception beside the step it affects. When you know what the reader sees after a step, say it.
- No fixed paragraph or sentence limits. Vary the structure, and merge short paragraphs that belong together.
- Put countable things one per line: options, conditions, files, places to look. Introduce each list with a line that ends in a colon.
- No em dashes or en dashes. The dash is a spaced hyphen ( - ). Ranges use "to" or a hyphen: "2 to 32 characters".
- Numbers as digits: "3 secrets", "every 6 hours", "2 printers". Fixed phrases ("one-time", "two-sided"), UI labels, quoted messages, and code stay as they are. Use "around" for a general figure.
- State limits and consequences flat: "The link works for 1 hour."
- Casual and plain, never corporate. No marketing, hedges, or filler. Don't write "simply", "just", "easy", "seamless", "robust", "powerful", "leverage", "streamline", "it's important to note", "it's worth noting", or "best" as a bare claim.
- Cut:
  - Sentences that restate what the reader already sees: the heading, a table or list right below, a badge, a count.
  - Instructions for controls the reader can figure out.
  - "X, not Y" or "instead of" lines that correct a mistake the reader never made.
  - Answers to questions nobody asked.
  - Intros that only announce what the page covers.
  - A closing line repeated in the same spot on every section or page.
- End after the expected result or the open problem. No closing summary, slogan, or offer of more help.
- Write only what the code does today. Do not describe planned features.
- No real people, hostnames, IP addresses, emails, server URLs, or ids. Use examples such as "Office laser", "Front desk Mac", `alex@example.com`, and `https://your-print-better.example`.

## Checking Pages

Run these from the repository root.

| Command | Does |
| --- | --- |
| `pnpm --dir server check:docs` | Checks every page. A page listed in `nav.ts` without a file is an error. |
| `pnpm --dir server check:docs --allow-missing` | Skips pages listed in `nav.ts` that have no file yet. |
| `pnpm --dir server check:docs devices` | Reports only problems under `content/devices`. |

## How It Is Built

Checked on 2026-11-19 against the installed packages.

- `server/vite.config.ts` compiles MDX with `@mdx-js/rollup` 3.1.1, `remark-gfm` 4 (tables), `rehype-slug` 6 (heading ids, same rules as GitHub), and `@shikijs/rehype` 4.6 (highlighting at build time). Shiki writes `github-light` and `github-dark` as CSS variables, and the app's own light or dark theme picks one.
- The MDX plugin removes the query from module ids, so it would also compile `?raw` imports. The `docsMdx` wrapper in `vite.config.ts` skips them. Search and "Copy page as Markdown" load the raw MDX with `?raw`.
- Each page is its own chunk, loaded by `server/src/docs/content-index.ts`. The main app bundle does not include the docs.
- `/docs` and every path under it render the docs app before any sign-in check, and the docs app calls no API. The Worker's `run_worker_first` list does not include `/docs`, so static assets and the single-page-app fallback serve it.
- The checker compiles each page with `@mdx-js/mdx`, the compiler that `@mdx-js/rollup` uses.
- The layout copies the three-column shadcn docs layout with the app's own components, fonts, and theme.
