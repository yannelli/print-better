import { Route } from 'wouter'
import { Loading } from '@/components/states'
import { useExtensions } from '@/hooks/extensions'
import { useWs } from '@/hooks/workspace'
import NotFound from '@/routes/not-found'
import { EXTENSION_UI } from './index'
import type { ExtensionPage } from './registry'
import { usePages } from './slot'

const ALL_PAGES = EXTENSION_UI.flatMap((ext) => ext.pages ?? [])

function PageGate({ page }: { page: ExtensionPage }) {
  const ws = useWs()
  const extensions = useExtensions(ws)
  const shown = usePages(ws).includes(page)
  if (extensions.isPending) return <Loading />
  if (!shown) return <NotFound />
  return <page.Component />
}

/** A route for every extension page, for the workspace `<Switch>`; each shows only while its extension is active and the caller may see it. */
export const extensionRoutes = () =>
  ALL_PAGES.map((page) => (
    <Route key={page.path} path={page.path}>
      <PageGate page={page} />
    </Route>
  ))
