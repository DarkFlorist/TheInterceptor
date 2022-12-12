import * as preact from 'preact'
import { ChangeChain } from './components/pages/ChangeChain.js'

function rerender() {
	const element = preact.createElement(ChangeChain, {})
	preact.render(element, document.body)
}

rerender()
