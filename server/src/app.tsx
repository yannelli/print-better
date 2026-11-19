import { lazy, Suspense } from 'react'
import { Route, Switch } from 'wouter'
import { FullPageLoading, RequireAuth, RootRedirect, UserRoute, WorkspaceRoute } from '@/routes/guards'
import { Loading } from '@/components/states'
import NotFound from '@/routes/not-found'

const Setup = lazy(() => import('@/routes/auth/setup'))
const Login = lazy(() => import('@/routes/auth/login'))
const Signup = lazy(() => import('@/routes/auth/signup'))
const Recover = lazy(() => import('@/routes/auth/recover'))
const Reset = lazy(() => import('@/routes/auth/reset'))
const VerifyEmail = lazy(() => import('@/routes/auth/verify-email'))
const Invite = lazy(() => import('@/routes/auth/invite'))
const DeviceApprove = lazy(() => import('@/routes/auth/device'))
const OAuthConsent = lazy(() => import('@/routes/auth/oauth-consent'))
const Welcome = lazy(() => import('@/routes/auth/welcome'))

const Home = lazy(() => import('@/routes/home/home'))
const Printers = lazy(() => import('@/routes/printers/printers'))
const PrinterDetail = lazy(() => import('@/routes/printers/printer-detail'))
const Jobs = lazy(() => import('@/routes/jobs/jobs'))
const Devices = lazy(() => import('@/routes/devices/devices'))
const AddDevice = lazy(() => import('@/routes/devices/add-device'))
const DeviceDetail = lazy(() => import('@/routes/devices/device-detail'))
const Members = lazy(() => import('@/routes/members/members'))
const WorkspaceSettings = lazy(() => import('@/routes/settings/workspace-settings'))

const Account = lazy(() => import('@/routes/account/account'))
const Admin = lazy(() => import('@/routes/admin/admin'))
const ConnectAi = lazy(() => import('@/routes/connect/connect-ai'))

function WorkspacePages() {
  return (
    <Suspense fallback={<Loading />}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/printers" component={Printers} />
        <Route path="/printers/:id/:tab?" component={PrinterDetail} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/devices" component={Devices} />
        <Route path="/devices/add" component={AddDevice} />
        <Route path="/devices/:id" component={DeviceDetail} />
        <Route path="/members/:tab?" component={Members} />
        <Route path="/settings/:tab?" component={WorkspaceSettings} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  )
}

function UserPages() {
  return (
    <Suspense fallback={<Loading />}>
      <Switch>
        <Route path="/account/:tab?" component={Account} />
        <Route path="/admin/:tab?" component={Admin} />
        <Route path="/connect" component={ConnectAi} />
      </Switch>
    </Suspense>
  )
}

export function App() {
  return (
    <Suspense fallback={<FullPageLoading />}>
      <Switch>
        <Route path="/setup" component={Setup} />
        <Route path="/login" component={Login} />
        <Route path="/signup" component={Signup} />
        <Route path="/recover" component={Recover} />
        <Route path="/reset-password" component={Reset} />
        <Route path="/verify-email" component={VerifyEmail} />
        <Route path="/invite/:token" component={Invite} />
        <Route path="/device">
          <RequireAuth>
            <DeviceApprove />
          </RequireAuth>
        </Route>
        <Route path="/oauth/consent">
          <RequireAuth>
            <OAuthConsent />
          </RequireAuth>
        </Route>
        <Route path="/welcome">
          <RequireAuth>
            <Welcome />
          </RequireAuth>
        </Route>
        <Route path="/w/:ws" nest>
          <WorkspaceRoute>
            <WorkspacePages />
          </WorkspaceRoute>
        </Route>
        <Route path={/^\/(account|admin|connect)(\/.*)?$/}>
          <UserRoute>
            <UserPages />
          </UserRoute>
        </Route>
        <Route path="/" component={RootRedirect} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  )
}
