import * as preact from 'preact'
import { App } from './components/App.js'
import { ErrorBoundary } from './components/subcomponents/Error.js'
import {
	POPUP_PERFORMANCE_MARKS,
	markPerformance,
} from './utils/popupPerformance.js'

function scheduleFrame(callback: FrameRequestCallback) {
	if (typeof globalThis.requestAnimationFrame === 'function')
		return globalThis.requestAnimationFrame(callback)
	return globalThis.setTimeout(() => callback(performance.now()), 16)
}

function rerender() {
	markPerformance(POPUP_PERFORMANCE_MARKS.scriptStart)
	preact.render(
		preact.createElement(ErrorBoundary, {}, preact.createElement(App, {})),
		document.body,
	)
	scheduleFrame(() => {
		scheduleFrame(() => {
			markPerformance(POPUP_PERFORMANCE_MARKS.shellPaint)
		})
	})
}

rerender()
