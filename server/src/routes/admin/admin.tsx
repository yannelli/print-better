import { ShieldCheck } from 'lucide-react'
import { Link } from 'wouter'
import { PageHeader } from '@/components/page'
import { EmptyState, QueryState } from '@/components/states'
import { buttonVariants } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAdminSettings } from '@/hooks/account'
import { useUser } from '@/hooks/auth'
import { useTab } from '../settings/use-tab'
import { EmailTab } from './email-tab'
import { GeneralTab } from './general-tab'
import { PeopleTab } from './people-tab'
import { SignInTab } from './sign-in-tab'

const TABS = ['general', 'sign-in', 'email', 'people'] as const

function AdminPages() {
  const settings = useAdminSettings()
  const [tab, setTab] = useTab('admin', TABS)
  return (
    <>
      <PageHeader title="Server admin" description="Settings for everyone who uses this Print Better server." />
      <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof TABS)[number])} className="gap-8">
        <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="sign-in">Sign-in options</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <QueryState query={settings}>{(data) => <GeneralTab settings={data} />}</QueryState>
        </TabsContent>
        <TabsContent value="sign-in">
          <QueryState query={settings}>{(data) => <SignInTab settings={data} />}</QueryState>
        </TabsContent>
        <TabsContent value="email">
          <QueryState query={settings}>{(data) => <EmailTab settings={data} />}</QueryState>
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab />
        </TabsContent>
      </Tabs>
    </>
  )
}

export default function Admin() {
  const user = useUser()
  if (!user?.isAdmin) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Only server admins can see this"
        description="Ask the person who set up Print Better if you need a setting changed."
        action={
          <Link href="~/" className={buttonVariants({ variant: 'outline' })}>
            Go to Home
          </Link>
        }
      />
    )
  }
  return <AdminPages />
}
