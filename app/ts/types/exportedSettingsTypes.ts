import * as funtypes from 'funtypes'
import { RpcNetwork } from './rpc.js'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory, OptionalEthereumAddress } from './wire-types.js'
import { AddressBookEntries, ContactEntries } from './addressBookTypes.js'
import { WebsiteAccessArray } from './websiteAccessTypes.js'
import { EditEnsNamedHashWindowState, ModifyAddressWindowState } from './visualizer-types.js'
import { RichAccountBalances, RichToken, RichTokenLayout } from './richMode.js'
import { SigningAddressPreferences } from './signerTypes.js'
import { assertNever } from '../utils/typescript.js'

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

const currentExportedSettingsFields = {
	activeSimulationAddress: OptionalEthereumAddress,
	rpcNetwork: RpcNetwork,
	openedPage: Page,
	useSignersAddressAsActiveAddress: funtypes.Boolean,
	websiteAccess: WebsiteAccessArray,
	simulationMode: funtypes.Boolean,
	addressBookEntries: AddressBookEntries,
	useTabsInsteadOfPopup: funtypes.Boolean,
	metamaskCompatibilityMode: funtypes.Boolean,
}

const ExportedRichListElement = funtypes.ReadonlyObject({
	address: EthereumAddress,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('CurrentActiveAddress'), funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded')),
})

const independentAddressExportedSettingsFields = {
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
}

const richExportedSettingsFields = {
	makeCurrentAddressRich: funtypes.Boolean,
	richNativeAmount: EthereumQuantity,
	fixedAddressRichList: funtypes.ReadonlyArray(ExportedRichListElement),
	richTokens: funtypes.ReadonlyArray(RichToken),
	richAccountBalances: RichAccountBalances,
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
		settings: funtypes.ReadonlyObject(currentExportedSettingsFields)
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.5'),
		// Rich-mode and independent-address branches both produced 1.5 backups before merging; accept each field set.
		settings: funtypes.ReadonlyObject({
			...currentExportedSettingsFields,
			...richExportedSettingsFields,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.5'),
		settings: funtypes.ReadonlyObject({
			...independentAddressExportedSettingsFields,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.6'),
		settings: funtypes.ReadonlyObject({
			...independentAddressExportedSettingsFields,
			safeAppsCompatibilityMode: funtypes.Boolean,
		})
	}),
	funtypes.ReadonlyObject({
		...exportedSettingsEnvelopeFields,
		version: funtypes.Literal('1.7'),
		settings: funtypes.ReadonlyObject({
			...independentAddressExportedSettingsFields,
			...richExportedSettingsFields,
			// Amounts belong exclusively to per-account balances; layouts describe how to apply them.
			richTokens: funtypes.ReadonlyArray(RichTokenLayout),
			safeAppsCompatibilityMode: funtypes.Boolean,
		})
	}),
)


type ExportedSettingsOfVersion<Version extends ExportedSettings['version']> = Extract<ExportedSettings, { version: Version }>['settings']
type IndependentAddressExportedSettings = Extract<ExportedSettingsOfVersion<'1.5'>, { signingAddressPreferences: unknown }> | ExportedSettingsOfVersion<'1.6'> | ExportedSettingsOfVersion<'1.7'>
type RichFundingExportedSettings = Extract<ExportedSettingsOfVersion<'1.5'>, { richTokens: unknown }> | ExportedSettingsOfVersion<'1.7'>

// Every version-dependent part of an export. A feature a version does not carry is undefined (or the legacy address-book format), so the import never decides feature presence from a version list of its own.
export type ExportedSettingsFeatures = {
	readonly kind: 'current' | 'independent-addresses' | 'legacy-rich' | 'legacy'
	readonly addressBook: { readonly format: 'entries', readonly entries: AddressBookEntries } | { readonly format: 'active-addresses-and-contacts', readonly addressInfos: readonly ActiveAddress[], readonly contacts: ContactEntries | undefined }
	readonly openedPage: Page | undefined
	// undefined for 1.0, whose export names a chain instead of an RPC network; the import then uses the default network.
	readonly rpcNetwork: RpcNetwork | undefined
	readonly metamaskCompatibilityMode: boolean | undefined
	readonly safeAppsCompatibilityMode: boolean | undefined
	readonly richFunding: RichFundingExportedSettings | undefined
	readonly independentAddresses: IndependentAddressExportedSettings | undefined
}

const legacyAddressBook = (settings: { readonly addressInfos: readonly ActiveAddress[], readonly contacts: ContactEntries | undefined }) => ({ format: 'active-addresses-and-contacts' as const, addressInfos: settings.addressInfos, contacts: settings.contacts })
const addressBookEntries = (entries: AddressBookEntries) => ({ format: 'entries' as const, entries })

// The one version table of exported settings. Historical branches both exported 1.5; this schema-owned classifier makes the only shape-based distinction. Adding a version literal fails to compile until it is classified here.
export function classifyExportedSettings(exported: ExportedSettings): ExportedSettingsFeatures {
	switch (exported.version) {
		case '1.0': return { kind: 'legacy', addressBook: legacyAddressBook(exported.settings), openedPage: undefined, rpcNetwork: undefined, metamaskCompatibilityMode: undefined, safeAppsCompatibilityMode: undefined, richFunding: undefined, independentAddresses: undefined }
		case '1.1': return { kind: 'legacy', addressBook: legacyAddressBook(exported.settings), openedPage: undefined, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: undefined, safeAppsCompatibilityMode: undefined, richFunding: undefined, independentAddresses: undefined }
		case '1.2': return { kind: 'legacy', addressBook: legacyAddressBook(exported.settings), openedPage: undefined, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: exported.settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: undefined, richFunding: undefined, independentAddresses: undefined }
		case '1.3': return { kind: 'legacy', addressBook: legacyAddressBook(exported.settings), openedPage: exported.settings.openedPage, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: exported.settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: undefined, richFunding: undefined, independentAddresses: undefined }
		case '1.4': return { kind: 'legacy', addressBook: addressBookEntries(exported.settings.addressBookEntries), openedPage: exported.settings.openedPage, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: exported.settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: undefined, richFunding: undefined, independentAddresses: undefined }
		case '1.5': {
			const settings = exported.settings
			const shared = { addressBook: addressBookEntries(settings.addressBookEntries), openedPage: settings.openedPage, rpcNetwork: settings.rpcNetwork, metamaskCompatibilityMode: settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: undefined }
			return 'richTokens' in settings
				? { kind: 'legacy-rich', ...shared, richFunding: settings, independentAddresses: undefined }
				: { kind: 'independent-addresses', ...shared, richFunding: undefined, independentAddresses: settings }
		}
		case '1.6': return { kind: 'independent-addresses', addressBook: addressBookEntries(exported.settings.addressBookEntries), openedPage: exported.settings.openedPage, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: exported.settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: exported.settings.safeAppsCompatibilityMode, richFunding: undefined, independentAddresses: exported.settings }
		case '1.7': return { kind: 'current', addressBook: addressBookEntries(exported.settings.addressBookEntries), openedPage: exported.settings.openedPage, rpcNetwork: exported.settings.rpcNetwork, metamaskCompatibilityMode: exported.settings.metamaskCompatibilityMode, safeAppsCompatibilityMode: exported.settings.safeAppsCompatibilityMode, richFunding: exported.settings, independentAddresses: exported.settings }
		default: return assertNever(exported)
	}
}
