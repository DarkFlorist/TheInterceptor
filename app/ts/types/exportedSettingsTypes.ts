import * as funtypes from 'funtypes'
import { SafeAppsHostOrigins } from './safeAppsHosting.js'
import { RpcNetwork } from './rpc.js'
import { EthereumAddress, EthereumQuantity, LiteralConverterParserFactory, OptionalEthereumAddress } from './wire-types.js'
import { AddressBookEntries, ContactEntries, type AddressBookEntry } from './addressBookTypes.js'
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

const safeExportedSettingsFields = {
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

function defineSettingsFormat<Version extends string, Fields extends Parameters<typeof funtypes.ReadonlyObject>[0]>(version: Version, fields: Fields) {
	return funtypes.ReadonlyObject({ ...exportedSettingsEnvelopeFields, version: funtypes.Literal(version), settings: funtypes.ReadonlyObject(fields) })
}

// Keep historical field definitions intact; schema presence drives normalization rather than separate version lists in consumers.
const legacySettingsFormats = [
	defineSettingsFormat('1.0', { ...legacyExportedSettingsFields, activeChain: EthereumQuantity }),
	defineSettingsFormat('1.1', rpcLegacyExportedSettingsFields),
	defineSettingsFormat('1.2', compatibilityExportedSettingsFields),
	defineSettingsFormat('1.3', { ...compatibilityExportedSettingsFields, openedPage: Page }),
	defineSettingsFormat('1.4', {
		activeSimulationAddress: OptionalEthereumAddress,
		rpcNetwork: RpcNetwork,
		openedPage: Page,
		useSignersAddressAsActiveAddress: funtypes.Boolean,
		websiteAccess: WebsiteAccessArray,
		simulationMode: funtypes.Boolean,
		addressBookEntries: AddressBookEntries,
		useTabsInsteadOfPopup: funtypes.Boolean,
		metamaskCompatibilityMode: funtypes.Boolean,
	}),
	defineSettingsFormat('1.5', safeExportedSettingsFields),
	defineSettingsFormat('1.6', { ...safeExportedSettingsFields, safeAppsCompatibilityMode: funtypes.Boolean }),
]

export const CURRENT_EXPORTED_SETTINGS_VERSION = '1.7'

export type CurrentExportedSettings = funtypes.Static<typeof CurrentExportedSettings>
export const CurrentExportedSettings = defineSettingsFormat(CURRENT_EXPORTED_SETTINGS_VERSION, {
	...safeExportedSettingsFields,
	safeAppsCompatibilityMode: funtypes.Boolean,
	safeAppsHostOrigins: SafeAppsHostOrigins,
})

export type ExportedSettings = funtypes.Static<typeof ExportedSettings>
export const ExportedSettings = funtypes.Union(CurrentExportedSettings, ...legacySettingsFormats)

export function createSettingsExport(settings: CurrentExportedSettings['settings'], exportedDate: string): CurrentExportedSettings {
	return { name: CurrentExportedSettings.fields.name.value, version: CurrentExportedSettings.fields.version.value, exportedDate, settings }
}

export function normalizeImportedSettings(exported: ExportedSettings, defaults: { readonly activeSimulationAddress: EthereumAddress, readonly rpcNetwork: RpcNetwork }) {
	const settings = exported.settings
	// Pre-1.5 addresses were shared by signing and simulation; reset ambiguous mode state to explicit defaults.
	const convertActiveAddress = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact', useAsActiveAddress: true, entrySource: 'User' })
	return {
		activeSimulationAddress: 'signingAddressPreferences' in settings ? settings.activeSimulationAddress : defaults.activeSimulationAddress,
		activeSigningSafeAddress: 'activeSigningSafeAddress' in settings ? settings.activeSigningSafeAddress : undefined,
		signingAddressPreferences: 'signingAddressPreferences' in settings ? settings.signingAddressPreferences : [],
		rpcNetwork: 'rpcNetwork' in settings ? settings.rpcNetwork : defaults.rpcNetwork,
		openedPage: 'openedPage' in settings ? settings.openedPage : undefined,
		addressBookEntries: 'addressBookEntries' in settings ? settings.addressBookEntries : undefined,
		legacyAddressBookEntries: 'addressInfos' in settings ? settings.addressInfos.map(convertActiveAddress).concat(settings.contacts ?? []) : undefined,
		useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
		websiteAccess: settings.websiteAccess,
		simulationMode: settings.simulationMode,
		useTabsInsteadOfPopup: settings.useTabsInsteadOfPopup,
		metamaskCompatibilityMode: 'metamaskCompatibilityMode' in settings ? settings.metamaskCompatibilityMode : undefined,
		safeAppsCompatibilityMode: 'safeAppsCompatibilityMode' in settings ? settings.safeAppsCompatibilityMode : false,
		// Older backups have no hosting selection; preserve the current selection during import.
		safeAppsHostOrigins: 'safeAppsHostOrigins' in settings ? settings.safeAppsHostOrigins : undefined,
	}
}
