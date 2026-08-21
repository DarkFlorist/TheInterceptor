import * as funtypes from 'funtypes'
import { RpcNetwork } from './rpc.js'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory, OptionalEthereumAddress } from './wire-types.js'
import { AddressBookEntries, ContactEntries } from './addressBookTypes.js'
import { WebsiteAccessArray } from './websiteAccessTypes.js'
import { EditEnsNamedHashWindowState, ModifyAddressWindowState } from './visualizer-types.js'
import { SigningAddressPreferences } from './signerTypes.js'

export type Page = funtypes.Static<typeof Page>
export const Page = funtypes.Union(
	funtypes.ReadonlyObject({ page: funtypes.Literal('Home') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('AddNewAddress'), state: ModifyAddressWindowState }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('ModifyAddress'), state: ModifyAddressWindowState }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('ChangeActiveAddress') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('AccessList') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('Settings') }),
	funtypes.ReadonlyObject({ page: funtypes.Literal('EditEnsNamedHash'), state: EditEnsNamedHashWindowState }),
)

export type ActiveAddress = funtypes.Static<typeof ActiveAddress>
export const ActiveAddress = funtypes.ReadonlyObject({
	name: funtypes.String,
	address: EthereumAddress,
	askForAddressAccess: funtypes.Union(funtypes.Boolean, funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, true))),
}).asReadonly()

type ActiveAddressArray = funtypes.Static<typeof ActiveAddressArray>
const ActiveAddressArray = funtypes.ReadonlyArray(ActiveAddress)

const exportedSettingsEnvelopeFields = {
	name: funtypes.Literal('InterceptorSettingsAndAddressBook'),
	exportedDate: funtypes.String,
}

const legacyExportedSettingsFields = {
	activeSimulationAddress: OptionalEthereumAddress,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
	addressInfos: ActiveAddressArray,
	contacts: funtypes.Union(funtypes.Undefined, ContactEntries),
	useTabsInsteadOfPopup: funtypes.Boolean,
}

const rpcLegacyExportedSettingsFields = {
	...legacyExportedSettingsFields,
	rpcNetwork: RpcNetwork,
}

const compatibilityExportedSettingsFields = {
	...rpcLegacyExportedSettingsFields,
	metamaskCompatibilityMode: funtypes.Boolean,
}

export type ExportedSettings = funtypes.Static<typeof ExportedSettings>
export const ExportedSettings = funtypes.Union(
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.0'),
		settings: funtypes.ReadonlyObject({
			...legacyExportedSettingsFields,
			activeChain: EthereumQuantity,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.1'),
		settings: funtypes.ReadonlyObject({
			...rpcLegacyExportedSettingsFields,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.2'),
		settings: funtypes.ReadonlyObject({
			...compatibilityExportedSettingsFields,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.3'),
		settings: funtypes.ReadonlyObject({
			...compatibilityExportedSettingsFields,
			openedPage: Page,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.4'),
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
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.5'),
		settings: funtypes.ReadonlyObject({
			activeSimulationAddress: OptionalEthereumAddress,
			activeSigningSafeAddress: OptionalEthereumAddress,
			signingAddressPreferences: SigningAddressPreferences,
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
