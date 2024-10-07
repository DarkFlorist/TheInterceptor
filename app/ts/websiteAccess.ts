import * as preact from 'preact'
import { WebsiteAccessView } from './components/pages/WebsiteAccess.js'

function rerender() {
	const body = document.body
	const main = document.querySelector('main')!
	const app = preact.createElement(WebsiteAccessView, {})
	preact.render(app, body, main)
}

rerender()
