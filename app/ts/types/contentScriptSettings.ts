import * as funtypes from 'funtypes'
import { SafeAppsHostOrigins } from './safeAppsHosting.js'

export const ContentScriptHostingSettings = funtypes.ReadonlyPartial({ safeAppsCompatibilityMode: funtypes.Boolean, safeAppsHostOrigins: SafeAppsHostOrigins })
// Storage validation, registration snapshots and observation use the same hosting field definitions.
export const contentScriptHostingSettingsKeys = Object.keys(ContentScriptHostingSettings.fields)
