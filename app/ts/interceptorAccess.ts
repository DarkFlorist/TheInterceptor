import * as preact from 'preact'
import { InterceptorAccess } from './components/pages/InterceptorAccess.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(InterceptorAccess, {})), document.body)
}

rerender()
