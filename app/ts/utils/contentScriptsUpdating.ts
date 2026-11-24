import { getInterceptorDisabledSites, getWebsiteAccess } from '../background/websiteAccessStorage.js'
import { reportUnexpectedError } from './errors.js'
import { type ContentScriptRegistrationDependencies, updateManifestV2ContentScripts, updateManifestV3ContentScripts, updateContentScriptRegistrations } from './contentScriptsRegistration.js'

export { getManifestV3ExcludeMatches } from './contentScriptsRegistration.js'

const dependencies: ContentScriptRegistrationDependencies = {
	readDisabledSites: async () => getInterceptorDisabledSites(await getWebsiteAccess()),
	reportError: async (error, context) => { await reportUnexpectedError(error, context) },
}

export const updateContentScriptInjectionStrategyManifestV2 = async () => await updateManifestV2ContentScripts(dependencies)
export const updateContentScriptInjectionStrategyManifestV3 = async () => await updateManifestV3ContentScripts(dependencies)
export const updateContentScriptInjectionStrategy = async () => await updateContentScriptRegistrations(dependencies)
