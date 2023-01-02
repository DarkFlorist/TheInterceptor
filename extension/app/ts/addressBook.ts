import * as preact from 'preact'
import { AddressBook } from './components/pages/AddressBook.js'

function rerender() {
	const element = preact.createElement(AddressBook, {})
	preact.render(element, document.body)
}

rerender()
