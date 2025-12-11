import * as preact from 'preact'
import { FetchSimulationStack } from './components/pages/FetchSimulationStack.js'

function rerender() {
	const element = preact.createElement(FetchSimulationStack, {})
	preact.render(element, document.body)
}

rerender()
