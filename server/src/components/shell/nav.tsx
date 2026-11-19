import { Bot, House, LaptopMinimal, ListChecks, type LucideIcon, Printer, Settings, ShieldCheck, Users } from 'lucide-react'
import { Link } from 'wouter'
import { usePathname } from 'wouter/use-browser-location'
import { StatusDot } from '@/components/status'
import { useUser } from '@/hooks/auth'
import { usePrinters } from '@/hooks/printers'
import { cn } from '@/lib/utils'
import { printerStatus } from '@/lib/words'
import { wsHref } from './app-actions'

interface NavItem {
  label: string
  icon: LucideIcon
  href: string
  exact?: boolean
  badge?: 'attention'
}

function useNavItems(ws: string): { main: NavItem[]; more: NavItem[] } {
  const user = useUser()
  return {
    main: [
      { label: 'Home', icon: House, href: wsHref(ws), exact: true },
      { label: 'Printers', icon: Printer, href: wsHref(ws, '/printers'), badge: 'attention' },
      { label: 'Print jobs', icon: ListChecks, href: wsHref(ws, '/jobs') },
      { label: 'Devices', icon: LaptopMinimal, href: wsHref(ws, '/devices') },
      { label: 'Members', icon: Users, href: wsHref(ws, '/members') },
      { label: 'Settings', icon: Settings, href: wsHref(ws, '/settings') },
    ],
    more: [
      { label: 'Connect AI', icon: Bot, href: '~/connect' },
      ...(user?.isAdmin ? [{ label: 'Server admin', icon: ShieldCheck, href: '~/admin' }] : []),
    ],
  }
}

function useNeedsAttention(ws: string) {
  const { data } = usePrinters(ws)
  return data?.some((p) => p.added && ['warn', 'bad'].includes(printerStatus(p).tone)) ?? false
}

function NavLink({ item, active, attention, onNavigate }: { item: NavItem; active: boolean; attention: boolean; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      data-active={active || undefined}
      className={cn(
        'group/nav press relative flex h-11 items-center gap-3 rounded-full px-4 text-[0.9375rem] font-medium text-muted-foreground',
        'hover:text-foreground data-active:text-on-brand-container',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-full transition-[scale,opacity] duration-500 ease-spring',
          active
            ? 'scale-x-100 bg-brand-container opacity-100'
            : 'scale-x-[0.6] bg-muted opacity-0 group-hover/nav:scale-x-100 group-hover/nav:opacity-100',
        )}
      />
      <Icon className="relative size-5 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
      <span className="relative flex-1 truncate">{item.label}</span>
      {attention && (
        <span className="relative" title="A printer needs attention">
          <StatusDot tone="warn" />
          <span className="sr-only">, a printer needs attention</span>
        </span>
      )}
    </Link>
  )
}

export function NavList({ ws, onNavigate }: { ws: string; onNavigate?: () => void }) {
  const { main, more } = useNavItems(ws)
  const pathname = usePathname()
  const attention = useNeedsAttention(ws)
  const isActive = (item: NavItem) => {
    const target = item.href.slice(1)
    return item.exact ? pathname === target || pathname === `${target}/` : pathname === target || pathname.startsWith(`${target}/`)
  }
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      <ul className="flex flex-col gap-1">
        {main.map((item) => (
          <li key={item.href}>
            <NavLink item={item} active={isActive(item)} attention={item.badge === 'attention' && attention} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-1 border-t pt-4">
        {more.map((item) => (
          <li key={item.href}>
            <NavLink item={item} active={isActive(item)} attention={false} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </nav>
  )
}
