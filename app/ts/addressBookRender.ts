import * as preact from 'preact'
import { AddressBook } from './AddressBook.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('addressBook')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(AddressBook, {})), document.body)
}

rerender()
