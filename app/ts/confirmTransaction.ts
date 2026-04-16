import * as preact from 'preact'
import { ConfirmTransaction } from './components/pages/ConfirmTransaction.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('confirmTransaction')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(ConfirmTransaction, {})), document.body)
}

rerender()
