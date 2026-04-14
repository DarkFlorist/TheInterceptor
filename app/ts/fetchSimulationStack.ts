import * as preact from 'preact'
import { FetchSimulationStack } from './components/pages/FetchSimulationStack.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(FetchSimulationStack, {})), document.body)
}

rerender()
