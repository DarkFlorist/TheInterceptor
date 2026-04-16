import * as preact from 'preact'
import { InterceptorAccess } from './components/pages/InterceptorAccess.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('interceptorAccess')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(InterceptorAccess, {})), document.body)
}

rerender()
