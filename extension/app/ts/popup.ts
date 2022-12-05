import * as preact from 'preact'
import { App } from './components/App'

function rerender() {
	const element = preact.createElement(App, {})
	preact.render(element, document.body)
}

rerender()
