import * as preact from 'preact'
import { WatchAsset } from './components/pages/WatchAsset.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(WatchAsset, {})), document.body)
