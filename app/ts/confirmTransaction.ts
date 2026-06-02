import * as preact from 'preact'
import { ConfirmTransaction } from './components/pages/ConfirmTransaction.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(ConfirmTransaction, {})), document.body)
}

rerender()
