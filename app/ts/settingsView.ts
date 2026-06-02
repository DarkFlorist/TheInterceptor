import * as preact from 'preact'
import { SettingsView } from './components/pages/SettingsView.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(SettingsView, {})), document.body)
}

rerender()
