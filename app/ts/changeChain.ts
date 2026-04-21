import * as preact from 'preact'
import { ChangeChain } from './components/pages/ChangeChain.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(ChangeChain, {})), document.body)
}

rerender()
