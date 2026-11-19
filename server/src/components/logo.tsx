import { cn } from '@/lib/utils'

/** The mark: a sheet coming out of a printer slot. Same colors in both themes; mirrors public/favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={cn('size-8 shrink-0', className)}>
      <rect x="4" y="4" width="504" height="504" rx="116" className="fill-[#0c0c0e] dark:fill-[#1f1f24] dark:stroke-white/15" strokeWidth="8" />
      <rect x="80" y="118" width="352" height="72" rx="36" className="fill-[#303036] dark:fill-[#3c3c44]" />
      <path d="M136 154H376V366a32 32 0 0 1-32 32H168a32 32 0 0 1-32-32Z" fill="#fafafa" />
      <path d="M110 154H402" className="stroke-[#0c0c0e] dark:stroke-[#1f1f24]" strokeWidth="12" strokeLinecap="round" />
      <path d="M192 240H320" stroke="#2563eb" strokeWidth="30" strokeLinecap="round" />
      <path d="M192 302H284" stroke="#0c0c0e" strokeWidth="30" strokeLinecap="round" />
    </svg>
  )
}
