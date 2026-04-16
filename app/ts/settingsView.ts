import * as preact from 'preact'
import { SettingsView } from './components/pages/SettingsView.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import { initializeUiPort } from './ui/uiPort.js'

initializeUiPort('settingsView')

function rerender() {
	preact.render(preact.createElement(ErrorBoundary, {}, preact.createElement(SettingsView, {})), document.body)
}

rerender()
