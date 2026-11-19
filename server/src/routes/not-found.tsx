import { FileQuestion } from 'lucide-react'
import { Link } from 'wouter'
import { EmptyState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-xl items-center px-5">
      <EmptyState
        icon={FileQuestion}
        title="This page doesn’t exist"
        description="The link may be old, or the item was removed."
        action={
          <Link href="~/" className={buttonVariants()}>
            Go to Home
          </Link>
        }
        className="w-full"
      />
    </div>
  )
}
