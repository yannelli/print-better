import { ArrowRight, Info, Lightbulb, TriangleAlert } from 'lucide-react'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Link } from 'wouter'
import { Tabs as TabsRoot, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const callouts = {
  note: { icon: Info, className: 'border-info/25 bg-info-container/45', iconClass: 'text-info' },
  tip: { icon: Lightbulb, className: 'border-ok/25 bg-ok-container/45', iconClass: 'text-ok' },
  warning: { icon: TriangleAlert, className: 'border-warn/40 bg-warn-container/55', iconClass: 'text-warn' },
}

export function Callout({ type = 'note', title, children }: { type?: keyof typeof callouts; title?: string; children: ReactNode }) {
  const style = callouts[type] ?? callouts.note
  return (
    <div className={cn('docs-callout my-6 flex gap-3 rounded-2xl border px-4 py-3.5', style.className)}>
      <style.icon className={cn('mt-1 size-5 shrink-0', style.iconClass)} aria-hidden />
      <div className="min-w-0 text-[0.9375rem] leading-7">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  )
}

export function Steps({ children }: { children: ReactNode }) {
  return <div className="docs-steps my-8">{children}</div>
}

export function Tab({ children }: { label: string; children: ReactNode }) {
  return <>{children}</>
}

type TabElement = ReactElement<{ label: string; children: ReactNode }>

export function Tabs({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children).filter((child): child is TabElement => isValidElement(child))
  return (
    <TabsRoot defaultValue={0} className="my-6 gap-0">
      <TabsList className="max-w-full justify-start overflow-x-auto overflow-y-hidden">
        {tabs.map((tab, index) => (
          <TabsTrigger key={tab.props.label} value={index} className="flex-none">
            {tab.props.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => (
        <TabsContent key={tab.props.label} value={index} className="docs-tabpanel text-base">
          {tab.props.children}
        </TabsContent>
      ))}
    </TabsRoot>
  )
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="my-6 grid gap-3 sm:grid-cols-2">{children}</div>
}

export function Card({ href, title, children }: { href: string; title: string; children?: ReactNode }) {
  return (
    <Link href={href} className="docs-card group press flex flex-col gap-1 rounded-3xl border bg-card p-5 hover:bg-muted/60">
      <span className="flex items-center justify-between gap-2 font-semibold">
        {title}
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
      {children && <div className="text-sm leading-6 text-muted-foreground">{children}</div>}
    </Link>
  )
}
