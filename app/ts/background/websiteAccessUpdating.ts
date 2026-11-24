// Compatibility name for callers that need the disabled-sites-changed result; every access update now enforces registration refresh.
export { updateWebsiteAccess as updateWebsiteAccessAndContentScriptInjectionStrategy } from './websiteAccessStorage.js'
