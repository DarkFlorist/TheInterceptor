import { POPUP_PERFORMANCE_MARKS, markPerformance } from './utils/popupPerformance.js'
import './background/background-startup.js'
import { keepTabStateCleanupAlive } from './background/tabStateLifecycle.js'
import { refreshContentScriptInjectionStrategy } from './background/contentScriptInjectionStrategy.js'
import { silenceChromeUnCaughtPromise } from './utils/requests.js'

markPerformance(POPUP_PERFORMANCE_MARKS.backgroundLoaded)

self.addEventListener('install', () => {
	console.info('The Interceptor installed')
})

self.addEventListener('activate', (event) => {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundActivated)
	keepTabStateCleanupAlive(event)
})

silenceChromeUnCaughtPromise(refreshContentScriptInjectionStrategy())
