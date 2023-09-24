import { MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { ExportedSettings, Page } from '../types/exportedSettingsTypes.js'
import { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { NetworkPrice } from '../types/visualizer-types.js'
import { EthereumAddress } from '../types/wire-types.js'
import { ActiveAddressArray, ContactEntries } from '../types/addressBookTypes.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { RpcEntries, RpcNetwork } from '../types/rpc.js'

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
	{
		name: 'Ethereum (experimental geth)',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/winedancemuffinborrow',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: false,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
	{
		name: 'Ethereum (experimental nethermind)',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/birdchalkrenewtip',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: false,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
]

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
	return {
		activeSimulationAddress: 'activeSimulationAddress' in results ? results.activeSimulationAddress : defaultAddresses[0].address,
		page: results.page ?? 'Home',
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress ?? false,
		websiteAccess: results.websiteAccess ?? [],
		rpcNetwork: results.rpcNetwork ?? defaultRpcs[0],
		simulationMode: results.simulationMode ?? true,
		userAddressBook: {
			activeAddresses: results.addressInfos ?? defaultAddresses,
			contacts: results.contacts ?? [],
		}
	}
}

export const setPage = async (page: Page) => await browserStorageLocalSet({page})

export const setMakeMeRich = async (makeMeRich: boolean) => await browserStorageLocalSet({ makeMeRich })
export const getMakeMeRich = async() => (await browserStorageLocalGet('makeMeRich'))?.['makeMeRich'] ?? false

export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined) {
	return await browserStorageLocalSet({
		useSignersAddressAsActiveAddress,
		...useSignersAddressAsActiveAddress === true ? { activeSigningAddress: currentSignerAddress } : {}
	})
}

export async function changeSimulationMode(changes: { simulationMode: boolean, rpcNetwork?: RpcNetwork, activeSimulationAddress?: EthereumAddress | undefined, activeSigningAddress?: EthereumAddress | undefined }) {
	return await browserStorageLocalSet({
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { rpcNetwork: changes.rpcNetwork }: {},
		...'activeSimulationAddress' in changes ? { activeSimulationAddress: changes.activeSimulationAddress }: {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: changes.activeSigningAddress }: {},
	})
}

export const getWebsiteAccess = async() => (await browserStorageLocalGet('websiteAccess'))?.['websiteAccess'] ?? []
const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		return await browserStorageLocalSet({ websiteAccess: updateFunc(await getWebsiteAccess()) })
	})
}

const getActiveAddresses = async() => (await browserStorageLocalGet('addressInfos'))?.['addressInfos'] ?? defaultAddresses
const activeAddressesSemaphore = new Semaphore(1)
export async function updateActiveAddresses(updateFunc: (prevState: ActiveAddressArray) => ActiveAddressArray) {
	await activeAddressesSemaphore.execute(async () => {
		return await browserStorageLocalSet({ addressInfos: updateFunc(await getActiveAddresses()) })
	})
}

const getContacts = async() => (await browserStorageLocalGet('contacts'))?.['contacts'] ?? []
const contactsSemaphore = new Semaphore(1)
export async function updateContacts(updateFunc: (prevState: ContactEntries) => ContactEntries) {
	await contactsSemaphore.execute(async () => {
		return await browserStorageLocalSet({ contacts: updateFunc(await getContacts()) })
	})
}

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.['useTabsInsteadOfPopup'] ?? false
export const setUseTabsInsteadOfPopup = async(useTabsInsteadOfPopup: boolean) => await browserStorageLocalSet({ useTabsInsteadOfPopup })

export const getMetamaskCompatibilityMode = async() => (await browserStorageLocalGet('metamaskCompatibilityMode'))?.['metamaskCompatibilityMode'] ?? false
export const setMetamaskCompatibilityMode = async(metamaskCompatibilityMode: boolean) => await browserStorageLocalSet({ metamaskCompatibilityMode })


export async function exportSettingsAndAddressBook() {
	const results = {
		name: 'InterceptorSettingsAndAddressBook' as const,
		version: '1.2' as const,
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
			'metamaskCompatibilityMode',
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
	await updateActiveAddresses(() => exportedSetings.settings.addressInfos)
	await updateWebsiteAccess(() => exportedSetings.settings.websiteAccess)
	await updateContacts(() => exportedSetings.settings.contacts === undefined ? [] : exportedSetings.settings.contacts)
	await setUseTabsInsteadOfPopup(exportedSetings.settings.useTabsInsteadOfPopup)
	if (exportedSetings.version === '1.2') {
		await setUseTabsInsteadOfPopup(exportedSetings.settings.metamaskCompatibilityMode)
	}
}
