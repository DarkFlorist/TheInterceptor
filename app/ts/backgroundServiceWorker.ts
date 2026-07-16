import { POPUP_PERFORMANCE_MARKS, markPerformance } from './utils/popupPerformance.js'
import './background/background-startup.js'
import { clearTabStates } from './background/storageVariables.js'
import { updateContentScriptInjectionStrategyManifestV3 } from './utils/contentScriptsUpdating.js'

markPerformance(POPUP_PERFORMANCE_MARKS.backgroundLoaded)

self.addEventListener('install', () => {
	console.info('The Interceptor installed')
})

self.addEventListener('activate', () => {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundActivated)
	clearTabStates()
})

updateContentScriptInjectionStrategyManifestV3()
