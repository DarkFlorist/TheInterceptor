import * as funtypes from 'funtypes'
import { startupStorageCodecs, hostingStorageCodecs } from './startupStorageCodecs.js'

export const ContentScriptHostingSettings = funtypes.ReadonlyPartial(funtypes.ReadonlyPartial(hostingStorageCodecs).pick('safeAppsCompatibilityMode').fields)

// Pick canonical codecs so a persisted-key rename is a type error instead of an independent schema drifting.
export const AutomaticGnosisSafeAppsHostingSettings = funtypes.ReadonlyPartial({
	...ContentScriptHostingSettings.fields,
	...funtypes.ReadonlyPartial(startupStorageCodecs).pick('simulationMode', 'activeSigningSafeAddress', 'independentActiveSimulationAddress', 'useSignersAddressAsActiveAddress', 'activeRpcNetwork', 'websiteAccess', 'signingAddressPreferences').fields,
	...funtypes.ReadonlyPartial(hostingStorageCodecs).pick('userAddressBookEntriesV3').fields,
})
export const automaticGnosisSafeAppsHostingSettingsKeys = Object.keys(AutomaticGnosisSafeAppsHostingSettings.fields)
