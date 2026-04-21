import * as preact from 'preact'
import { WebsiteAccessView } from './components/pages/WebsiteAccess.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	const body = document.body
	const main = document.querySelector('main')!
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(WebsiteAccessView, {})), body, main)
}

rerender()
