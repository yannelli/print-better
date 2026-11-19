import type { User } from '@shared/types'
import { ConnectedAccountsSection } from './connected-accounts-section'
import { PasskeysSection } from './passkeys-section'
import { PasswordSection } from './password-section'
import { RecoverySection } from './recovery-section'
import { SessionsSection } from './sessions-section'

export function SecurityTab({ user }: { user: User }) {
  return (
    <div className="flex flex-col gap-10">
      <PasskeysSection />
      <PasswordSection user={user} />
      <ConnectedAccountsSection />
      <RecoverySection />
      <SessionsSection />
    </div>
  )
}
