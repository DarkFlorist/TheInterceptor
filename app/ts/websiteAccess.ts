import * as preact from 'preact'
import { WebsiteAccess } from './components/pages/WebsiteAccess.js'

function rerender() {
	const element = preact.createElement(WebsiteAccess, {})
	preact.render(element, document.body)
}

rerender()
