import {  MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { LegacyWebsiteAccessArray, Page, Settings, WebsiteAccessArray, WebsiteAccessArrayWithLegacy } from '../utils/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet, browserStorageLocalSetKeys, browserStorageLocalSingleGetWithDefault } from '../utils/storageUtils.js'
import { AddressInfoArray, ContactEntries } from '../utils/user-interface-types.js'
import { NetworkPrice, OptionalEthereumAddress, RpcEntries, RpcNetwork } from '../utils/visualizer-types.js'
import { EthereumAddress, EthereumAddressOrMissing, EthereumQuantity } from '../utils/wire-types.js'
import * as funtypes from 'funtypes'

export const defaultAddresses = [
	{
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
	},
	{
		name: 'Public private key',
		address: MOCK_PRIVATE_KEYS_ADDRESS,
		askForAddressAccess: false,
	}
]

export const networkPriceSources: { [chainId: string]: NetworkPrice } = {
	'1': {
		quoteToken: { address: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n, decimals: 18n, symbol: 'ETH' },
		priceSources: {
			uniswapV2Like: [
				{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2
			],
			uniswapV3Like: [
				{ factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984n, initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' } // Uniswap V3
			]
		}
	},
	'5': {
		quoteToken: { address: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n, decimals: 18n, symbol: 'ETH' },
		priceSources: {
			uniswapV2Like: [
				{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2 Goerli deployment
			],
			uniswapV3Like: []
		}
	},
	'11155111': {
		quoteToken: { address: 0x105083929bf9bb22c26cb1777ec92661170d4285n, decimals: 18n, symbol: 'ETH' },
		priceSources: {
			uniswapV2Like: [],
			uniswapV3Like: []
		}
	}
} as const

export const defaultRpcs: RpcEntries = [
	{
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n
	},
	{
		name: 'Goerli',
		chainId: 5n,
		httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		currencyName: 'Goerli Testnet ETH',
		currencyTicker: 'GÖETH',
		primary: true,
		minimized: true,
		weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n
	},
	{
		name: 'Sepolia',
		chainId: 11155111n,
		httpsRpc: 'https://rpc-sepolia.dark.florist/flipcardtrustone',
		currencyName: 'Sepolia Testnet ETH',
		currencyTicker: 'SEETH',
		primary: true,
		minimized: true,
		weth: 0x105083929bf9bb22c26cb1777ec92661170d4285n,
	},
	/*
	{
		name: 'Eth (geth-multi)',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/winedancemuffinborrow',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: false,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
	{
		name: 'Eth (neth-multi)',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/birdchalkrenewtip',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: false,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
	*/
]

function parseAccessWithLegacySupport(data: unknown): WebsiteAccessArray {
	const parsed = WebsiteAccessArrayWithLegacy.parse(data)
	if (parsed.length === 0) return []
	if ('origin' in parsed[0]) {
		const legacy = LegacyWebsiteAccessArray.parse(data)
		return legacy.map((x) => ({
			access: x.access,
			addressAccess: x.addressAccess,
			website: {
				websiteOrigin: x.origin,
				icon: x.originIcon,
				title: undefined,
			},
		}))
	}
	return WebsiteAccessArray.parse(data)
}

export async function getSettings() : Promise<Settings> {
	const results = await browserStorageLocalGet([
		'activeSimulationAddress',
		'addressInfos',
		'page',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'rpcNetwork',
		'simulationMode',
		'contacts',
	])
	const useSignersAddressAsActiveAddress = results.useSignersAddressAsActiveAddress !== undefined ? funtypes.Boolean.parse(results.useSignersAddressAsActiveAddress) : false
	return {
		activeSimulationAddress: results.activeSimulationAddress !== undefined ? EthereumAddressOrMissing.parse(results.activeSimulationAddress) : defaultAddresses[0].address,
		page: results.page !== undefined ? Page.parse(results.page) : 'Home',
		useSignersAddressAsActiveAddress: useSignersAddressAsActiveAddress,
		websiteAccess: results.websiteAccess !== undefined ? parseAccessWithLegacySupport(results.websiteAccess) : [],
		rpcNetwork: results.rpcNetwork !== undefined ? RpcNetwork.parse(results.rpcNetwork) : defaultRpcs[0],
		simulationMode: results.simulationMode !== undefined ? funtypes.Boolean.parse(results.simulationMode) : true,
		userAddressBook: {
			addressInfos: results.addressInfos !== undefined ? AddressInfoArray.parse(results.addressInfos): defaultAddresses,
			contacts: ContactEntries.parse(results.contacts !== undefined ? results.contacts : []),
		}
	}
}

export async function setPage(page: Page) {
	return await browserStorageLocalSet('page', page)
}

export async function setMakeMeRich(makeMeRich: boolean) {
	return await browserStorageLocalSet('makeMeRich', makeMeRich)
}
export async function getMakeMeRich() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('makeMeRich', false))
}
export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined) {
	return await browserStorageLocalSetKeys({
		'useSignersAddressAsActiveAddress': useSignersAddressAsActiveAddress,
		...useSignersAddressAsActiveAddress === true ? { 'activeSigningAddress': EthereumAddressOrMissing.serialize(currentSignerAddress) as string } : {}
	})
}

export async function changeSimulationMode(changes: { simulationMode: boolean, rpcNetwork?: RpcNetwork, activeSimulationAddress?: EthereumAddress | undefined, activeSigningAddress?: EthereumAddress | undefined }) {
	return await browserStorageLocalSetKeys({
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { rpcNetwork: RpcNetwork.serialize(changes.rpcNetwork) as string }: {},
		...'activeSimulationAddress' in changes ? { activeSimulationAddress: EthereumAddressOrMissing.serialize(changes.activeSimulationAddress) as string }: {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: EthereumAddressOrMissing.serialize(changes.activeSigningAddress) as string }: {},
	})
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const websiteAccess = WebsiteAccessArray.parse(await browserStorageLocalSingleGetWithDefault('websiteAccess', []))
		return await browserStorageLocalSet('websiteAccess', WebsiteAccessArray.serialize(updateFunc(websiteAccess)) as string)
	})
}

const addressInfosSemaphore = new Semaphore(1)
export async function updateAddressInfos(updateFunc: (prevState: AddressInfoArray) => AddressInfoArray) {
	await addressInfosSemaphore.execute(async () => {
		const addressInfos = AddressInfoArray.parse(await browserStorageLocalSingleGetWithDefault('addressInfos', AddressInfoArray.serialize(defaultAddresses)))
		return await browserStorageLocalSet('addressInfos', AddressInfoArray.serialize(updateFunc(addressInfos)) as string)
	})
}

const contactsSemaphore = new Semaphore(1)
export async function updateContacts(updateFunc: (prevState: ContactEntries) => ContactEntries) {
	await contactsSemaphore.execute(async () => {
		const contacts = ContactEntries.parse(await browserStorageLocalSingleGetWithDefault('contacts', []))
		return await browserStorageLocalSet('contacts', ContactEntries.serialize(updateFunc(contacts)) as string)
	})
}

export async function getUseTabsInsteadOfPopup() {
	return funtypes.Boolean.parse(await browserStorageLocalSingleGetWithDefault('useTabsInsteadOfPopup', false))
}

export async function setUseTabsInsteadOfPopup(useTabsInsteadOfPopup: boolean) {
	return await browserStorageLocalSet('useTabsInsteadOfPopup', funtypes.Boolean.serialize(useTabsInsteadOfPopup) as string)
}

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
)

export async function exportSettingsAndAddressBook() {
	const results = {
		name: 'InterceptorSettingsAndAddressBook' as const,
		version: '1.1' as const,
		exportedDate: (new Date).toISOString().split('T')[0],
		settings: await browserStorageLocalGet([
			'activeSimulationAddress',
			'addressInfos',
			'page',
			'useSignersAddressAsActiveAddress',
			'websiteAccess',
			'rpcNetwork',
			'simulationMode',
			'contacts',
			'useTabsInsteadOfPopup',
		])
	}
	return ExportedSettings.parse(results)
}

export async function importSettingsAndAddressBook(exportedSetings: ExportedSettings) {
	if (exportedSetings.version === '1.0') {
		await changeSimulationMode({
			simulationMode: exportedSetings.settings.simulationMode,
			rpcNetwork: defaultRpcs[0],
			activeSimulationAddress: exportedSetings.settings.activeSimulationAddress,
			activeSigningAddress: undefined,
		})
	} else {
		await changeSimulationMode({
			simulationMode: exportedSetings.settings.simulationMode,
			rpcNetwork: exportedSetings.settings.rpcNetwork,
			activeSimulationAddress: exportedSetings.settings.activeSimulationAddress,
			activeSigningAddress: undefined,
		})
	}

	await setUseSignersAddressAsActiveAddress(exportedSetings.settings.useSignersAddressAsActiveAddress)
	await setPage(exportedSetings.settings.page)
	await updateAddressInfos(() => exportedSetings.settings.addressInfos)
	await updateWebsiteAccess(() => exportedSetings.settings.websiteAccess)
	await updateContacts(() => exportedSetings.settings.contacts === undefined ? [] : exportedSetings.settings.contacts)
	await setUseTabsInsteadOfPopup(exportedSetings.settings.useTabsInsteadOfPopup)
}
