import {
  BookOpen,
  Bot,
  Building2,
  House,
  LaptopMinimal,
  ListChecks,
  type LucideIcon,
  Monitor,
  Moon,
  Palette,
  Plus,
  Printer,
  Settings,
  ShieldCheck,
  Sun,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react'
import { useLocation } from 'wouter'
import { usePages } from '@/extensions/slot'
import { useSession } from '@/hooks/auth'
import { useClients } from '@/hooks/devices'
import { usePrinters } from '@/hooks/printers'
import { rememberWorkspace } from '@/hooks/workspace'
import { prefsStore } from '@/lib/prefs'
import { useAppActions, wsHref } from './app-actions'

export interface CommandItem {
  id: string
  group: string
  label: string
  hint?: string
  keywords?: string
  icon: LucideIcon
  run: () => void
}

export function useCommandItems(ws: string): CommandItem[] {
  const [, navigate] = useLocation()
  const actions = useAppActions()
  const session = useSession().data
  const printers = usePrinters(ws).data ?? []
  const clients = useClients(ws).data ?? []
  const pages = usePages(ws)
  const go = (path: string) => () => navigate(path)

  const items: CommandItem[] = [
    { id: 'print', group: 'Do something', label: 'Print something', keywords: 'upload file document', icon: Printer, run: () => actions.openPrint() },
    { id: 'add-device', group: 'Do something', label: 'Add a device', keywords: 'computer mac windows linux raspberry pi install pair', icon: Plus, run: go(wsHref(ws, '/devices/add')) },
    { id: 'invite', group: 'Do something', label: 'Invite someone', keywords: 'member people share', icon: UserPlus, run: go(wsHref(ws, '/members')) },
    { id: 'new-ws', group: 'Do something', label: 'New workspace', icon: Building2, run: actions.openNewWorkspace },
    { id: 'customize', group: 'Do something', label: 'Customize the look', keywords: 'theme color text size bigger font density', icon: Palette, run: actions.openCustomize },

    { id: 'nav-home', group: 'Go to', label: 'Home', icon: House, run: go(wsHref(ws)) },
    { id: 'nav-printers', group: 'Go to', label: 'Printers', icon: Printer, run: go(wsHref(ws, '/printers')) },
    { id: 'nav-jobs', group: 'Go to', label: 'Print jobs', keywords: 'history queue', icon: ListChecks, run: go(wsHref(ws, '/jobs')) },
    ...pages.flatMap(({ nav }) => (nav ? [{ id: `nav-${nav.href}`, group: 'Go to', label: nav.label, icon: nav.icon, run: go(wsHref(ws, nav.href)) }] : [])),
    { id: 'nav-devices', group: 'Go to', label: 'Devices', keywords: 'computers clients', icon: LaptopMinimal, run: go(wsHref(ws, '/devices')) },
    { id: 'nav-members', group: 'Go to', label: 'Members', keywords: 'people users invites', icon: Users, run: go(wsHref(ws, '/members')) },
    { id: 'nav-settings', group: 'Go to', label: 'Workspace settings', icon: Settings, run: go(wsHref(ws, '/settings')) },
    { id: 'nav-account', group: 'Go to', label: 'Your account', keywords: 'password passkey profile tokens', icon: UserRound, run: go('~/account') },
    { id: 'nav-connect', group: 'Go to', label: 'Connect AI', keywords: 'mcp claude chatgpt assistant', icon: Bot, run: go('~/connect') },
  ]
  items.push({ id: 'nav-docs', group: 'Go to', label: 'Docs', keywords: 'help documentation guide manual how to', icon: BookOpen, run: go('~/docs') })
  if (session?.user?.isAdmin) {
    items.push({ id: 'nav-admin', group: 'Go to', label: 'Server admin', keywords: 'sso signup email', icon: ShieldCheck, run: go('~/admin') })
  }
  for (const p of printers.filter((x) => x.added)) {
    items.push({ id: `printer-${p.id}`, group: 'Printers', label: p.name, hint: p.location ?? p.clientName, keywords: p.makeModel ?? '', icon: Printer, run: go(wsHref(ws, `/printers/${p.id}`)) })
  }
  for (const c of clients) {
    items.push({ id: `client-${c.id}`, group: 'Devices', label: c.name, hint: c.hostname ?? undefined, icon: LaptopMinimal, run: go(wsHref(ws, `/devices/${c.id}`)) })
  }
  for (const w of session?.workspaces ?? []) {
    if (w.id === ws) continue
    items.push({
      id: `ws-${w.id}`,
      group: 'Switch workspace',
      label: w.name,
      icon: Building2,
      run: () => {
        rememberWorkspace(w.id)
        navigate(wsHref(w.id))
      },
    })
  }
  items.push(
    { id: 'theme-light', group: 'Appearance', label: 'Use light theme', icon: Sun, run: () => prefsStore.set({ theme: 'light' }) },
    { id: 'theme-dark', group: 'Appearance', label: 'Use dark theme', icon: Moon, run: () => prefsStore.set({ theme: 'dark' }) },
    { id: 'theme-system', group: 'Appearance', label: 'Match this device’s theme', keywords: 'automatic system', icon: Monitor, run: () => prefsStore.set({ theme: 'system' }) },
    { id: 'text-larger', group: 'Appearance', label: 'Make text larger', keywords: 'font size zoom', icon: Palette, run: () => prefsStore.set({ textSize: 'larger' }) },
  )
  return items
}

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items.filter((i) => !i.group.startsWith('Printers') && !i.group.startsWith('Devices'))
  return items.filter((i) => {
    const text = `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''} ${i.group}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}
