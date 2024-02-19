import { ETHEREUM_COIN_ICON, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import { ExportedSettings, Page } from '../types/exportedSettingsTypes.js'
import { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { EthereumAddress } from '../types/wire-types.js'
import { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { RpcNetwork } from '../types/rpc.js'
import { NetworkPrice } from '../types/visualizer-types.js'
import { browserStorageLocalGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, updateUserAddressBookEntries } from './storageVariables.js'
import { ActiveAddress } from '../types/addressBookTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'

export const defaultActiveAddresses = [
	{
		type: 'activeAddress' as const,
		entrySource: 'User' as const,
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
	},
	{
		type: 'activeAddress' as const,
		entrySource: 'User' as const,
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

export const defaultRpcs = [
	{
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/winedancemuffinborrow',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
	{
		name: 'Goerli',
		chainId: 5n,
		httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
		currencyName: 'Goerli Testnet ETH',
		currencyTicker: 'GÖETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
		weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
	},
	{
		name: 'Sepolia',
		chainId: 11155111n,
		httpsRpc: 'https://rpc-sepolia.dark.florist/flipcardtrustone',
		currencyName: 'Sepolia Testnet ETH',
		currencyTicker: 'SEETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
		weth: 0x105083929bf9bb22c26cb1777ec92661170d4285n,
	},
	{
		name: 'Ethereum Mainnet (old)',
		chainId: 1n,
		httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
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
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: false,
		minimized: true,
		weth: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n,
	},
] as const

export const isEthSimulateV1Node = (httpsRpc: string) => httpsRpc === 'https://rpc.dark.florist/winedancemuffinborrow' || httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' || httpsRpc === 'https://rpc-goerli.dark.florist/flipcardtrustone'

export async function getSettings() : Promise<Settings> {
	const results = await browserStorageLocalGet([
		'activeSimulationAddress',
		'openedPage',
		'useSignersAddressAsActiveAddress',
		'websiteAccess',
		'currentRpcNetwork',
		'simulationMode',
	])
	if (defaultRpcs[0] === undefined || defaultActiveAddresses[0] === undefined) throw new Error('default rpc or default address was missing')
	return {
		activeSimulationAddress: 'activeSimulationAddress' in results ? results.activeSimulationAddress : defaultActiveAddresses[0].address,
		openedPage: results.openedPage ?? { page: 'Home' },
		useSignersAddressAsActiveAddress: results.useSignersAddressAsActiveAddress ?? false,
		websiteAccess: results.websiteAccess ?? [],
		currentRpcNetwork: results.currentRpcNetwork !== undefined ? results.currentRpcNetwork : defaultRpcs[0],
		simulationMode: results.simulationMode ?? true,
	}
}

export function getInterceptorDisabledSites(settings: Settings): string[] {
	return settings.websiteAccess.filter((site) => site.interceptorDisabled === true).map((site) => site.website.websiteOrigin)
}

export const setPage = async (openedPage: Page) => await browserStorageLocalSet({ openedPage })
export const getPage = async() => (await browserStorageLocalGet('openedPage'))?.['openedPage'] ?? { page: 'Home' }

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

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.['useTabsInsteadOfPopup'] ?? false
export const setUseTabsInsteadOfPopup = async(useTabsInsteadOfPopup: boolean) => await browserStorageLocalSet({ useTabsInsteadOfPopup })

export const getMetamaskCompatibilityMode = async() => (await browserStorageLocalGet('metamaskCompatibilityMode'))?.['metamaskCompatibilityMode'] ?? false
export const setMetamaskCompatibilityMode = async(metamaskCompatibilityMode: boolean) => await browserStorageLocalSet({ metamaskCompatibilityMode })

export async function exportSettingsAndAddressBook(): Promise<ExportedSettings> {
	const exportDate = (new Date).toISOString().split('T')[0]
	if (exportDate === undefined) throw new Error('Datestring did not contain Date')
	const settings = await getSettings()
	return {
		name: 'InterceptorSettingsAndAddressBook' as const,
		version: '1.4' as const,
		exportedDate: exportDate,
		settings: {
			activeSimulationAddress: settings.activeSimulationAddress,
			openedPage: settings.openedPage,
			useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
			websiteAccess: settings.websiteAccess,
			rpcNetwork: settings.currentRpcNetwork,
			simulationMode: settings.simulationMode,
			addressBookEntries: await getUserAddressBookEntries(),
			useTabsInsteadOfPopup: await getUseTabsInsteadOfPopup(),
			metamaskCompatibilityMode: await getMetamaskCompatibilityMode(),
		}
	}
}

export async function importSettingsAndAddressBook(exportedSetings: ExportedSettings) {
	if (exportedSetings.version === '1.3') {
		await setPage(exportedSetings.settings.openedPage)
	} else if (exportedSetings.version === '1.0') {
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
	await updateWebsiteAccess(() => exportedSetings.settings.websiteAccess)
	await setUseTabsInsteadOfPopup(exportedSetings.settings.useTabsInsteadOfPopup)
	if (exportedSetings.version === '1.2') {
		await setUseTabsInsteadOfPopup(exportedSetings.settings.metamaskCompatibilityMode)
	}
	if (exportedSetings.version === '1.4') {
		await updateUserAddressBookEntries(() => exportedSetings.settings.addressBookEntries)
	} else {
		await updateUserAddressBookEntries((previousEntries) => {
			const convertActiveAddressToAddressBookEntry = (info: ActiveAddress) => ({ ...info, type: 'activeAddress' as const, entrySource: 'User' as const })
			return getUniqueItemsByProperties(previousEntries.concat(exportedSetings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSetings.settings.contacts ?? []), ['address'])
		})
	}
}
