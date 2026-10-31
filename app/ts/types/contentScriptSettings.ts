import * as funtypes from 'funtypes'
import { SafeAppsHostOrigins } from './safeAppsHosting.js'
import { WebsiteAccessArray } from './websiteAccessTypes.js'

export const ContentScriptHostingSettings = funtypes.ReadonlyPartial({ safeAppsCompatibilityMode: funtypes.Boolean, safeAppsHostOrigins: SafeAppsHostOrigins })
export const ContentScriptSettings = funtypes.ReadonlyPartial({ ...ContentScriptHostingSettings.fields, websiteAccess: WebsiteAccessArray })
// Storage validation, registration snapshots and observation use the same field definitions.
export const contentScriptRegistrationSettingsKeys = Object.keys(ContentScriptSettings.fields)
