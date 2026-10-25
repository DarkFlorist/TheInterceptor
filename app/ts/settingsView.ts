import * as preact from 'preact'
import { ManagementView } from './components/pages/ManagementView.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { installLegacyManagementHashRedirect } from './utils/legacyManagementHashes.js'

installLegacyManagementHashRedirect()

function rerender() {
	document.querySelector('body > main')?.remove()
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(ManagementView, {})), document.body)
}

rerender()
