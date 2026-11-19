import { PageHeader } from '@/components/page'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUser } from '@/hooks/auth'
import { useTab } from '../settings/use-tab'
import { ProfileTab } from './profile-tab'
import { SecurityTab } from './security-tab'
import { TokensTab } from './tokens-tab'

const TABS = ['profile', 'security', 'tokens'] as const

export default function Account() {
  const user = useUser()
  const [tab, setTab] = useTab('account', TABS)
  if (!user) return null
  return (
    <>
      <PageHeader title="Your account" description={`Signed in as ${user.username}.`} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof TABS)[number])} className="gap-8">
        <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Sign-in and security</TabsTrigger>
          <TabsTrigger value="tokens">Apps and tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileTab user={user} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab user={user} />
        </TabsContent>
        <TabsContent value="tokens">
          <TokensTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
