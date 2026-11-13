import { contentScriptRegistration } from './contentScriptRegistration.js'
import { updateContentScriptInjectionStrategyManifestV2 } from './manifestV2ContentScriptInjection.js'

export async function updateContentScriptInjectionStrategy() {
	if (browser.runtime.getManifest().manifest_version === 3) await contentScriptRegistration.update()
	else await updateContentScriptInjectionStrategyManifestV2()
}

export function startContentScriptInjectionStrategy() {
	if (browser.runtime.getManifest().manifest_version === 3) contentScriptRegistration.start()
	else void updateContentScriptInjectionStrategyManifestV2()
}
