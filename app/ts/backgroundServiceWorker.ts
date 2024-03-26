import './background/background-startup.js'
import { getHtmlFile } from './background/backgroundUtils.js'
import { clearTabStates } from './background/storageVariables.js'
import { updateContentScriptInjectionStrategyManifestV3 } from './utils/contentScriptsUpdating.js'
import { checkAndThrowRuntimeLastError } from './utils/requests.js'

const setPopupFile = async () => {
	await browser.action.setPopup({ popup: getHtmlFile('popup') })
	checkAndThrowRuntimeLastError()
}

setPopupFile()

self.addEventListener('install', () => {
	console.log('The Interceptor installed')
})

self.addEventListener('activate', () => clearTabStates())

updateContentScriptInjectionStrategyManifestV3()
