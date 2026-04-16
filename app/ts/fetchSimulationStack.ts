import * as preact from 'preact'
import { FetchSimulationStack } from './components/pages/FetchSimulationStack.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('fetchSimulationStack')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(FetchSimulationStack, {})), document.body)
}

rerender()
