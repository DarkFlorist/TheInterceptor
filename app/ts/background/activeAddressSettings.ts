import type { Settings } from '../types/interceptor-messages.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'

// Which settings decide the active account getActiveAddress resolves (backgroundUtils.ts). It depends only on the Settings type, so the wallet_sendCalls approval check (walletSendCallsBinding.ts), a synchronous gate on a settings snapshot, can compare them without depending on the extension messaging hub.

// Whether each Settings field decides which account getActiveAddress resolves. The table is typed by Settings, like SETTINGS_FIELDS in storedSettings.ts, so a new Settings field does not compile until it is classified here, and ActiveAddressSettings has exactly the fields classified as deciding.
export const ACTIVE_ADDRESS_SETTING_ROLES = {
	activeSimulationAddress: 'decidesActiveAddress',
	activeSigningSafeAddress: 'decidesActiveAddress',
	activeRpcNetwork: 'decidesActiveAddress',
	openedPage: 'doesNotDecideActiveAddress',
	useSignersAddressAsActiveAddress: 'decidesActiveAddress',
	websiteAccess: 'doesNotDecideActiveAddress',
	simulationMode: 'decidesActiveAddress',
} satisfies { readonly [Field in keyof Settings]: 'decidesActiveAddress' | 'doesNotDecideActiveAddress' }

type ActiveAddressSettingField = { [Field in keyof Settings]: typeof ACTIVE_ADDRESS_SETTING_ROLES[Field] extends 'decidesActiveAddress' ? Field : never }[keyof Settings]

// The settings that decide which account getActiveAddress resolves, keyed by their Settings field. The active network decides it only by its chain id, so renaming the network leaves the account unchanged.
export type ActiveAddressSettings = { readonly [Field in ActiveAddressSettingField]: Field extends 'activeRpcNetwork' ? Pick<Settings['activeRpcNetwork'], 'chainId'> : Settings[Field] }

// The resolution reads settings only through this selection, whose return type makes it select every field ACTIVE_ADDRESS_SETTING_ROLES classifies as deciding and no other, so haveSameActiveAddressSettings compares all of them.
export const getActiveAddressSettings = (settings: Settings): ActiveAddressSettings => ({
	simulationMode: settings.simulationMode,
	activeRpcNetwork: { chainId: settings.activeRpcNetwork.chainId },
	useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
	activeSimulationAddress: settings.activeSimulationAddress,
	activeSigningSafeAddress: settings.activeSigningSafeAddress,
})

// Whether two settings snapshots resolve the active account from the same settings.
export const haveSameActiveAddressSettings = (first: Settings, second: Settings) => stringifyJSONWithBigInts(getActiveAddressSettings(first)) === stringifyJSONWithBigInts(getActiveAddressSettings(second))
