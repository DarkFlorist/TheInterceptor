import { websiteAccessRegistrationDependencies } from '../background/websiteAccessStorage.js'
import { updateManifestV2ContentScripts, updateManifestV3ContentScripts } from './contentScriptsRegistration.js'

export { getManifestV3ExcludeMatches } from './contentScriptsRegistration.js'

export const updateContentScriptInjectionStrategyManifestV2 = async () => await updateManifestV2ContentScripts(websiteAccessRegistrationDependencies)
export const updateContentScriptInjectionStrategyManifestV3 = async () => await updateManifestV3ContentScripts(websiteAccessRegistrationDependencies)
