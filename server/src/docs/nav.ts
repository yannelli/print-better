export interface DocPage {
  /** Path after /docs/. The empty slug is /docs. The MDX file is content/<slug or "index">.mdx */
  slug: string
  title: string
  description: string
}

export interface DocSection {
  title: string
  pages: DocPage[]
}

export const DOC_SECTIONS: DocSection[] = [
  {
    title: 'Get started',
    pages: [
      { slug: '', title: 'Introduction', description: 'What Print Better does, and how a document gets from you to a printer.' },
      { slug: 'quickstart', title: 'Quickstart', description: 'Deploy Print Better, pair a computer, and print your first page.' },
      { slug: 'how-it-works', title: 'How it works', description: 'The server, devices, printers, and jobs, and how they work together.' },
    ],
  },
  {
    title: 'Self-hosting',
    pages: [
      { slug: 'self-hosting/deploy', title: 'Deploy to Cloudflare', description: 'Create the database, storage, and Worker, then open your server for the first time.' },
      { slug: 'self-hosting/configuration', title: 'Configuration', description: 'The settings in wrangler.jsonc, the secrets, and what Server admin controls.' },
      { slug: 'self-hosting/sign-in', title: 'Sign-in', description: 'Passwords, passkeys, Google sign-in, and who can create an account.' },
      { slug: 'self-hosting/email', title: 'Email', description: 'Verification and invite emails, and the address that receives email to print.' },
      { slug: 'self-hosting/updates-and-backups', title: 'Updates and backups', description: 'Update the server, apply database changes, and keep backups.' },
    ],
  },
  {
    title: 'Devices',
    pages: [
      { slug: 'devices/macos', title: 'Install on a Mac', description: 'Install the signed Print Better app and pair it with your server.' },
      { slug: 'devices/linux', title: 'Install on Linux', description: 'Install the client as a system service and pair it with your server.' },
      { slug: 'devices/raspberry-pi', title: 'Install on a Raspberry Pi', description: 'Turn a Raspberry Pi into an always-on print server for USB and network printers.' },
      { slug: 'devices/manage', title: 'Manage devices', description: 'Rename, remove, and check the health of the computers in your workspace.' },
      { slug: 'devices/discovery', title: 'Printer discovery', description: "How devices find printers on the network, over USB, and in the system's own printer list." },
      { slug: 'devices/updates', title: 'Automatic updates', description: 'How devices find and install new versions.' },
    ],
  },
  {
    title: 'Printers',
    pages: [
      { slug: 'printers/add', title: 'Add a printer', description: 'Choose which found printers people can print to.' },
      { slug: 'printers/settings', title: 'Printer settings', description: 'Name, location, default options, and two-sided printing.' },
      { slug: 'printers/status', title: 'Status and supplies', description: "Read a printer's state and toner or ink levels, and make it identify itself." },
      { slug: 'printers/lan-sharing', title: 'Share on your network', description: 'Let phones and computers on the same network print without signing in.' },
    ],
  },
  {
    title: 'Printing',
    pages: [
      { slug: 'printing/web', title: 'From the web app', description: 'Print from any browser, including your phone.' },
      { slug: 'printing/print-window', title: "From your computer's print window", description: 'Use any workspace printer from the print window on a Mac or Linux computer.' },
      { slug: 'printing/email', title: 'By email', description: "Send a document to a printer's email address." },
      { slug: 'printing/api', title: 'With the API', description: 'Print from scripts and other apps with an API token.' },
      { slug: 'printing/ai-assistants', title: 'With AI assistants', description: 'Connect Claude and other MCP clients so they can print for you.' },
      { slug: 'printing/jobs', title: 'Print jobs', description: 'Follow, cancel, retry, and download your jobs.' },
    ],
  },
  {
    title: 'Workspaces',
    pages: [
      { slug: 'workspaces/members', title: 'Members and roles', description: 'Invite people and choose what they can change.' },
      { slug: 'workspaces/settings', title: 'Workspace settings', description: 'The default printer, upload limits, document retention, and email to print.' },
      { slug: 'workspaces/tokens', title: 'API tokens', description: 'Create personal tokens for scripts, limit each to one workspace, and choose when it expires.' },
      { slug: 'workspaces/activity', title: 'Activity', description: 'See who changed what, and when.' },
    ],
  },
  {
    title: 'Extensions',
    pages: [
      { slug: 'extensions', title: 'Extensions', description: 'Optional features that stay off until you turn them on.' },
      { slug: 'extensions/printer-access', title: 'Printer access', description: 'Choose who can see, print to, and manage each printer.' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'reference/cli', title: 'Command line', description: 'Every printbetter command and option.' },
      { slug: 'reference/rest-api', title: 'REST API', description: 'Endpoints, authentication, errors, and pagination.' },
      { slug: 'reference/mcp', title: 'MCP tools', description: 'Every tool an AI assistant can use, and the scope it needs.' },
      { slug: 'reference/job-options', title: 'Job options', description: 'Copies, sides, color, paper, trays, quality, and page ranges.' },
      { slug: 'reference/security', title: 'Security', description: 'How Print Better protects accounts, devices, documents, and your network.' },
      { slug: 'reference/troubleshooting', title: 'Troubleshooting', description: 'Fix common problems with devices, printers, and jobs.' },
    ],
  },
]

export type DocEntry = DocPage & { section: string }

export const DOC_PAGES: DocEntry[] = DOC_SECTIONS.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.title })))

export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : '/docs'
}

export function findDocPage(path: string): DocEntry | undefined {
  const slug = path.replace(/^\/docs\/?/, '').replace(/\/+$/, '')
  return DOC_PAGES.find((page) => page.slug === slug)
}
