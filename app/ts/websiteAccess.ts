import * as preact from 'preact'
import { WebsiteAccessView } from './components/pages/WebsiteAccess.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('websiteAccess')

function rerender() {
	const body = document.body
	const main = document.querySelector('main')!
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(WebsiteAccessView, {})), body, main)
}

rerender()
