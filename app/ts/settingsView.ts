import * as preact from 'preact'
import { ManagementView } from './components/pages/ManagementView.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(ManagementView, {})), document.body)
}

rerender()
