import * as preact from 'preact'
import { SettingsView } from './components/pages/SettingsView.js'

function rerender() {
	const element = preact.createElement(SettingsView, {})
	preact.render(element, document.body)
}

rerender()
