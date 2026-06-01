import {
	POPUP_PERFORMANCE_MARKS,
	markPerformance,
} from './utils/popupPerformance.js'
import './background/background-startup.js'
import { getHtmlFile } from './background/backgroundUtils.js'
import { clearTabStates } from './background/storageVariables.js'
import { updateContentScriptInjectionStrategyManifestV3 } from './utils/contentScriptsUpdating.js'
import { checkAndThrowRuntimeLastError } from './utils/requests.js'

markPerformance(POPUP_PERFORMANCE_MARKS.backgroundLoaded)

const setPopupFile = async () => {
	// see https://issues.chromium.org/issues/337214677
	await (
		browser.action.setPopup as unknown as (
			details: browser.action._SetPopupDetails,
			callback: () => void,
		) => Promise<void>
	)({ popup: getHtmlFile('popup') }, () => {
		checkAndThrowRuntimeLastError()
	})
	checkAndThrowRuntimeLastError()
}
setPopupFile()

self.addEventListener('install', () => {
	console.info('The Interceptor installed')
})

self.addEventListener('activate', () => {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundActivated)
	clearTabStates()
})

updateContentScriptInjectionStrategyManifestV3()
