import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumAddressOrMissing } from './wire-types.js'
import { RpcNetwork } from './rpc.js'
import { WebsiteAccessArray } from './websiteAccessTypes.js'
import { Page } from './exportedSettingsTypes.js'
import { SigningAddressPreferences } from './signerTypes.js'
import { AddressBookEntries } from './addressBookTypes.js'

export type RichListElement = funtypes.Static<typeof RichListElement>
export const RichListElement = funtypes.ReadonlyObject({
	address: EthereumAddress,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('CurrentActiveAddress'), funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded')),
})

// Shared with startup reads so validating one setting never traverses unrelated storage unions.
export const startupStorageCodecs = {
	independentActiveSimulationAddress: EthereumAddressOrMissing,
	activeSigningSafeAddress: EthereumAddressOrMissing,
	openedPageV2: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
	activeRpcNetwork: RpcNetwork,
	makeCurrentAddressRich: funtypes.Boolean,
	fixedAddressRichList: funtypes.ReadonlyArray(RichListElement),
	signingAddressPreferences: SigningAddressPreferences,
	siteRpcInterceptionEnabled: funtypes.Boolean,
}


// Existing hosting preferences never opt users into HTTP simulation reads.
export const hostingStorageCodecs = { safeAppsCompatibilityMode: funtypes.Boolean, userAddressBookEntriesV3: AddressBookEntries }
