import * as funtypes from 'funtypes'
import { RpcNetwork } from './rpc.js'
import { EthereumQuantity, OptionalEthereumAddress } from './wire-types.js'
import { ActiveAddressArray, AddressBookEntries, ContactEntries } from './addressBookTypes.js'
import { WebsiteAccessArray } from './websiteAccessTypes.js'
import { ModifyAddressWindowState } from './visualizer-types.js'

export type Page = funtypes.Static<typeof Page>
export const Page = funtypes.Union(
	funtypes.ReadonlyObject({ page: funtypes.Literal('Home') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('AddNewAddress'), state: ModifyAddressWindowState }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('ModifyAddress'), state: ModifyAddressWindowState }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('ChangeActiveAddress') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('AccessList') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('Settings') }),
)
export type ExportedSettings = funtypes.Static<typeof ExportedSettings>
export const ExportedSettings = funtypes.Union(
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.0'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			activeChain: EthereumQuantity,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: ActiveAddressArray,
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
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: ActiveAddressArray,
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
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: ActiveAddressArray,
			contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
			useTabsInsteadOfPopup: funtypes.Boolean,
			metamaskCompatibilityMode: funtypes.Boolean,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.3'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			rpcNetwork: RpcNetwork,
			openedPage: Page,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressInfos: ActiveAddressArray,
			contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
			useTabsInsteadOfPopup: funtypes.Boolean,
			metamaskCompatibilityMode: funtypes.Boolean,
		})
	}),
	funtypes.ReadonlyObject({
		name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
		version: funtypes.Literal('1.4'),
		exportedDate: funtypes.String,
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			rpcNetwork: RpcNetwork,
			openedPage: Page,
			useSignersAddressAsActiveAddress: funtypes.Boolean,
			websiteAccess: WebsiteAccessArray,
			simulationMode: funtypes.Boolean,
			addressBookEntries: AddressBookEntries,
			useTabsInsteadOfPopup: funtypes.Boolean,
			metamaskCompatibilityMode: funtypes.Boolean,
		})
	}),
)
