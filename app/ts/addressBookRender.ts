import * as preact from 'preact'
import { AddressBook } from './AddressBook.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	// The standalone URL keeps its legacy entry point, but renders only one page root.
	document.querySelector('body > main')?.remove()
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement('div', { class: 'standalone-address-book-frame' }, preact.createElement(AddressBook, {}))), document.body)
}

rerender()
