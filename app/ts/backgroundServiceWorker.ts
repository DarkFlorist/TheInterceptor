import { POPUP_PERFORMANCE_MARKS, markPerformance } from './utils/popupPerformance.js'
import './background/background-startup.js'
import { keepTabStateCleanupAlive } from './background/tabStateLifecycle.js'
import { reportUnexpectedError } from './utils/errors.js'
import { updateContentScriptInjectionStrategyManifestV3 } from './utils/contentScriptsUpdating.js'

markPerformance(POPUP_PERFORMANCE_MARKS.backgroundLoaded)

self.addEventListener('install', () => {
	console.info('The Interceptor installed')
})

self.addEventListener('activate', (event) => {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundActivated)
	keepTabStateCleanupAlive(event)
})

void updateContentScriptInjectionStrategyManifestV3().catch(async (error: unknown) => await reportUnexpectedError(error, { code: 'content_script_registration_failed' }))
