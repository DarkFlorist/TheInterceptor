import * as funtypes from 'funtypes'
import { OptionalEthereumAddress, RpcNetwork } from './visualizer-types.js'
import { EthereumQuantity } from './wire-types.js'
import { AddressInfoArray, ContactEntries, Page, WebsiteAccessArray } from './user-interface-types.js'

export type ExportedSettings = funtypes.Static<typeof ExportedSettings>
export const ExportedSettings = funtypes.Union(
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.0'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			activeChain: EthereumQuantity,
			page: Page,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: AddressInfoArray,
			contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
			useTabsInsteadOfPopup: funtypes.Boolean,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.1'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			rpcNetwork: RpcNetwork,
			page: Page,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: AddressInfoArray,
			contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
			useTabsInsteadOfPopup: funtypes.Boolean,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.2'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			rpcNetwork: RpcNetwork,
			page: Page,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: AddressInfoArray,
			contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
			useTabsInsteadOfPopup: funtypes.Boolean,
			metamaskCompatibilityMode: funtypes.Boolean,
		})
	}),
)
