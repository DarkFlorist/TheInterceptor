import * as preact from 'preact'
import { NativeGnosisSafeAppsHost } from './components/pages/NativeGnosisSafeAppsHost.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

// Keep the generated page's stylesheet links outside the Preact root.
const main = document.querySelector('main')
if (main === null) throw new Error('Gnosis Safe Apps host root is missing')
preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(NativeGnosisSafeAppsHost, {})), main)
