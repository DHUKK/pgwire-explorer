import {
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '@tanstack/react-router'
import { Explorer } from './components/Explorer'
import { MessageIndex } from './components/MessageIndex'
import { LandingScreen } from './screens/LandingScreen'
import { CaptureError } from './lib/capture'
import { loadLocalCapture, loadScenarioCapture } from './lib/loadCapture'
import { NoticeBar, NoticeProvider } from './lib/notice'
import type { LoadedCapture } from './types'

/**
 * Four screens: pick a session, explore it, or read the message index.
 *
 * Hash history, because this ships as a static site on GitHub Pages and nothing
 * there rewrites an arbitrary path back to index.html. It is also the mode the
 * router's own docs recommend for exactly that case.
 *
 * The routes, all of them after the `#`:
 *
 *   /                the landing page
 *   /messages        the protocol message index
 *   /<scenario>      a shipped example
 *   /local/<name>    a capture saved in this browser
 *
 * A capture is the smallest thing a URL names here. There is deliberately no
 * route to a single message. Pointing at one meant carrying a session and a
 * packet id through the router, the loaded capture and the explorer, and it
 * fought the packet list's own scrolling for as long as it existed. The message
 * index is reference data now and links nowhere.
 *
 * A bare scenario id and a `local/` name cannot collide, which is why the prefix
 * is there: a saved file called `notify.json` never shadows the `notify` example.
 * A `local/` link only resolves in the browser holding that capture, since the
 * file itself is never uploaded anywhere. It is still worth a URL, because
 * reloading the page is what a reader does after re-recording.
 *
 * A capture is fetched by the route's own loader, so the screen does not render
 * until its capture is in hand. That is what stops a deep link showing the
 * landing page for a frame first. The router waits a second before showing any
 * pending UI, so a local fetch that takes 40ms shows nothing at all rather than
 * a spinner that flashes.
 */

const rootRoute = createRootRoute({
  component: () => (
    <NoticeProvider>
      <Outlet />
      <NoticeBar />
    </NoticeProvider>
  ),
})

/** The landing page, and the screen every failed load falls back to. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <LandingScreen />,
})

const messagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: MessagesScreen,
})

function MessagesScreen() {
  const navigate = useNavigate()
  return <MessageIndex onClose={() => void navigate({ to: '/' })} />
}

/**
 * The explorer, once its capture is loaded. Every capture route renders this,
 * since where the bytes came from stops mattering the moment they are decoded.
 */
function CaptureScreen({ loaded }: { loaded: LoadedCapture }) {
  const navigate = useNavigate()
  return <Explorer loaded={loaded} onClose={() => void navigate({ to: '/' })} />
}

/**
 * A load that failed. The landing page carrying the reason is the error screen,
 * so a reader ends up somewhere they can pick something else instead of at a
 * dead end. Anything the loader did not raise itself is still worth showing
 * plainly rather than as a blank page.
 */
function CaptureErrorScreen({ error }: { error: Error }) {
  return (
    <LandingScreen
      initialError={
        error instanceof CaptureError ? error : new CaptureError('Could not load that capture.')
      }
    />
  )
}

const localRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/local/$name',
  loader: async ({ params }) => {
    const loaded = await loadLocalCapture(params.name)
    // Throwing puts this on the landing page with the reason on it. The route a
    // reader followed can outlive the capture it names, so this is a normal
    // outcome rather than a fault.
    if (!loaded) throw new CaptureError(`"${params.name}" is not saved in this browser.`)
    return loaded
  },
  component: () => <CaptureScreen loaded={localRoute.useLoaderData()} />,
  errorComponent: CaptureErrorScreen,
})

const scenarioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$scenarioId',
  loader: ({ params }) => loadScenarioCapture(params.scenarioId),
  component: () => <CaptureScreen loaded={scenarioRoute.useLoaderData()} />,
  errorComponent: CaptureErrorScreen,
})

const routeTree = rootRoute.addChildren([indexRoute, messagesRoute, localRoute, scenarioRoute])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  scrollRestoration: ({ location }) => location.pathname === '/' || location.pathname === '/messages',
  scrollRestorationBehavior: 'instant',
  // Nothing here is a distinct document to a crawler, and the shell renders
  // instantly, so there is no separate not-found screen: an unknown route is a
  // scenario id that does not exist, which the error screen already explains.
  defaultNotFoundComponent: () => <LandingScreen />,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
