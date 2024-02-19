import './background/background-startup.js'
import { getHtmlFile } from './background/backgroundUtils.js'
import { clearTabStates } from './background/storageVariables.js'
import { updateContentScriptInjectionStrategyManifestV3 } from './utils/contentScriptsUpdating.js'

browser.action.setPopup({ popup: getHtmlFile('popup') })

self.addEventListener('install', () => {
	console.log('The Interceptor installed')
})

self.addEventListener('activate', () => clearTabStates())

updateContentScriptInjectionStrategyManifestV3()
