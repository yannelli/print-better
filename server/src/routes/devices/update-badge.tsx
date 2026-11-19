import { CircleArrowUp } from 'lucide-react'

export function UpdateBadge({ version }: { version: string }) {
  return (
    <span className="inline-flex h-6 w-fit items-center gap-1.5 rounded-full bg-info-container px-2.5 text-xs font-medium whitespace-nowrap text-on-info-container">
      <CircleArrowUp className="size-3.5" aria-hidden />
      Update available ({version})
    </span>
  )
}
