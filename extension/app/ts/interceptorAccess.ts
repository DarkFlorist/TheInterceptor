import * as preact from 'preact'
import { InterceptorAccess } from './components/pages/InterceptorAccess'

function rerender() {
	const element = preact.createElement(InterceptorAccess, {})
	preact.render(element, document.body)
}

rerender()
