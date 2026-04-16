import * as preact from 'preact'
import { App } from './components/App.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('main')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(App, {})), document.body)
}

rerender()
