import * as preact from 'preact'
import { AddressBook } from './AddressBook.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(AddressBook, {})), document.body)
}

rerender()
