import * as preact from 'preact'
import { SimulationStackPage } from './components/pages/SimulationStackPage.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import Hint from './components/subcomponents/Hint.js'

function rerender() {
	const root = document.getElementById('simulation-stack-root')
	if (root === null) throw new Error('Missing simulation stack root element')
	root.textContent = ''
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(Hint, { children: preact.createElement(SimulationStackPage, {}) })), root)
}

rerender()
