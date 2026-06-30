import * as preact from 'preact'
import { SimulationStackPage } from './components/pages/SimulationStackPage.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(SimulationStackPage, {})), document.body)
}

rerender()
