import * as preact from 'preact'
import { PersonalSign } from './components/pages/PersonalSign.js'

function rerender() {
	const element = preact.createElement(PersonalSign, {})
	preact.render(element, document.body)
}

rerender()
