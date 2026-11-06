import type { AddressBookEntries } from '../types/addressBookTypes.js'
import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import type { RpcNetwork } from '../types/rpc.js'

/** Normalize format capabilities once; applying an import does not need to know its version. */
export function normalizeSettingsImport(exported: ExportedSettings, defaultActiveAddress: bigint, defaultRpc: RpcNetwork) {
	const settings = exported.settings
	const addressBook: { readonly mode: 'replace' | 'merge', readonly entries: AddressBookEntries } = 'addressBookEntries' in settings
		? { mode: 'replace', entries: settings.addressBookEntries }
		: { mode: 'merge', entries: [...settings.addressInfos.map((info) => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })), ...settings.contacts ?? []] }
	// Before independent selections (1.5), a stored address represented both modes; reset rather than infer ownership.
	const independentSelection = 'signingAddressPreferences' in settings ? settings : undefined
	return {
		addressBook,
		signingWalletBindings: 'signingWalletBindings' in settings ? settings.signingWalletBindings : [],
		openedPage: 'openedPage' in settings ? settings.openedPage : undefined,
		rpcNetwork: 'rpcNetwork' in settings ? settings.rpcNetwork : defaultRpc,
		activeSimulationAddress: independentSelection === undefined ? defaultActiveAddress : independentSelection.activeSimulationAddress,
		activeSigningSafeAddress: independentSelection?.activeSigningSafeAddress,
		signingAddressPreferences: independentSelection?.signingAddressPreferences ?? [],
		metamaskCompatibilityMode: 'metamaskCompatibilityMode' in settings ? settings.metamaskCompatibilityMode : undefined,
		safeAppsCompatibilityMode: 'safeAppsCompatibilityMode' in settings ? settings.safeAppsCompatibilityMode : false,
		simulationMode: settings.simulationMode,
		useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
		websiteAccess: settings.websiteAccess,
		useTabsInsteadOfPopup: settings.useTabsInsteadOfPopup,
	}
}
