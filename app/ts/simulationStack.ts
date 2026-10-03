import * as preact from 'preact'
import { SimulationStackView } from './components/pages/SimulationStackPage.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	const root = document.getElementById('simulation-stack-root')
	if (root === null) throw new Error('Missing simulation stack root element')
	root.textContent = ''
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(SimulationStackView, { embedded: false })), root)
}

rerender()
