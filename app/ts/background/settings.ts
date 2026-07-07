import { ETHEREUM_COIN_ICON, MOCK_PRIVATE_KEYS_ADDRESS } from '../utils/constants.js'
import type { ActiveAddress, ExportedSettings, Page } from '../types/exportedSettingsTypes.js'
import type { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumAddress } from '../types/wire-types.js'
import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { BlockExplorer, RpcNetwork } from '../types/rpc.js'
import { type RichListElement, browserStorageLocalGet, browserStorageLocalSafeParseGet, browserStorageLocalSet } from '../utils/storageUtils.js'
import { getUserAddressBookEntries, updateUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import type { BlockTimeManipulation } from '../types/visualizer-types.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../simulation/services/SimulationModeEthereumClientService.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { mergeStoredWebsiteMetadata, sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

export const defaultActiveAddresses: AddressBookEntries = [
	{
		type: 'contact' as const,
		entrySource: 'User' as const,
		name: 'vitalik.eth',
		address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		askForAddressAccess: false,
		useAsActiveAddress: true,
		chainId: 'AllChains',
	},
	{
		type: 'contact' as const,
		entrySource: 'User' as const,
		name: 'Public private key',
		address: MOCK_PRIVATE_KEYS_ADDRESS,
		askForAddressAccess: false,
		useAsActiveAddress: true,
		chainId: 'AllChains',
	}
]

export const networkPriceSources = {
	uniswapV2Like: [
		{ factory: 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6fn, initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' }, // Uniswap V2
	],
	uniswapV3Like: [
		{ factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984n, initCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' } // Uniswap V3
	]
} as const

export const defaultRpcs = [
	{
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://ethereum.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
	},
	{
		name: 'Sepolia',
		chainId: 11155111n,
		httpsRpc: 'https://sepolia.dark.florist',
		currencyName: 'Sepolia Testnet ETH',
		currencyTicker: 'SEETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
	},
	{
		name: 'Holesky',
		chainId: 17000n,
		httpsRpc: 'https://holesky.dark.florist',
		currencyName: 'Holesky Testnet ETH',
		currencyTicker: 'HOETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: true,
		minimized: true,
	},
	{
		name: 'Ethereum (experimental nethermind)',
		chainId: 1n,
		httpsRpc: 'https://nethermind.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: ETHEREUM_COIN_ICON,
		primary: false,
		minimized: true,
	},
] as const

export const defaultSimulationMode = true

const wethForChainId = new Map<string, EthereumAddress>([
	['1', 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n], // Mainnet
	['11155111', 0x105083929bf9bb22c26cb1777ec92661170d4285n], // Sepolia
	['10', 0x4200000000000000000000000000000000000006n], //OP Mainnet
	['8453', 0x4200000000000000000000000000000000000006n], // Base
	['42161', 0x82af49447d8a07e3bd95bd0d56f35241523fbab1n], // Arbitrum
])

export const getDefaultBlockExplorer = (): BlockExplorer => ({ apiUrl: 'https://api.etherscan.io/v2/api', apiKey: 'PSW8C433Q667DVEX5BCRMGNAH9FSGFZ7Q8' })

export const getWethForChainId = (chainId: bigint) => wethForChainId.get(chainId.toString())

type StartupStorageDefaults = {
	activeSimulationAddress: Settings['activeSimulationAddress']
	openedPageV2: Page
	useSignersAddressAsActiveAddress: boolean
	websiteAccess: WebsiteAccessArray
	simulationMode: boolean
	activeRpcNetwork: RpcNetwork
	makeCurrentAddressRich: boolean
	fixedAddressRichList: readonly RichListElement[]
}

async function getParsedStorageValueOrDefault<Key extends keyof StartupStorageDefaults>(key: Key, defaultValue: StartupStorageDefaults[Key]): Promise<StartupStorageDefaults[Key]> {
	const rawValue = (await browser.storage.local.get(key))[key]
	const parsedValue = await browserStorageLocalSafeParseGet(key)
	if (parsedValue !== undefined && key in parsedValue) return parsedValue[key] as StartupStorageDefaults[Key]
	if (rawValue === undefined) return defaultValue
	console.warn(`${ key } was corrupt:`)
	console.warn(rawValue)
	await browserStorageLocalSet({ [key]: defaultValue } as unknown as Parameters<typeof browserStorageLocalSet>[0])
	return defaultValue
}

export async function getSettings() : Promise<Settings> {
	if (defaultRpcs[0] === undefined || defaultActiveAddresses[0] === undefined) throw new Error('default rpc or default address was missing')
	const defaultPage: Page = { page: 'Home' }
	const activeSimulationAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefault('activeSimulationAddress', defaultActiveAddresses[0].address))
	const openedPagePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefault('openedPageV2', defaultPage))
	const useSignersAddressAsActiveAddressPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefault('useSignersAddressAsActiveAddress', false))
	const websiteAccessPromise = silenceChromeUnCaughtPromise(getWebsiteAccess())
	const simulationModePromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefault('simulationMode', defaultSimulationMode))
	const activeRpcNetworkPromise = silenceChromeUnCaughtPromise(getParsedStorageValueOrDefault('activeRpcNetwork', defaultRpcs[0]))
	return {
		activeSimulationAddress: await activeSimulationAddressPromise,
		openedPage: await openedPagePromise,
		useSignersAddressAsActiveAddress: await useSignersAddressAsActiveAddressPromise,
		websiteAccess: await websiteAccessPromise,
		activeRpcNetwork: await activeRpcNetworkPromise,
		simulationMode: await simulationModePromise,
	}
}

export function getInterceptorDisabledSites(settings: Settings): string[] {
	return settings.websiteAccess.filter((site) => site.interceptorDisabled === true).map((site) => site.website.websiteOrigin)
}

export const setPage = async (openedPageV2: Page) => await browserStorageLocalSet({ openedPageV2 })
export const getPage = async() => (await browserStorageLocalGet('openedPageV2'))?.openedPageV2 ?? { page: 'Home' }

export const setMakeCurrentAddressRich = async (makeCurrentAddressRich: boolean) => await browserStorageLocalSet({ makeCurrentAddressRich })
export const getMakeCurrentAddressRich = async() => await getParsedStorageValueOrDefault('makeCurrentAddressRich', false)

export const setFixedMakeMeRichList = async (fixedAdressRichList: readonly RichListElement[]) => await browserStorageLocalSet({ fixedAddressRichList: fixedAdressRichList })
export async function getFixedAddressRichList() { return await getParsedStorageValueOrDefault('fixedAddressRichList', []) }

export async function setUseSignersAddressAsActiveAddress(useSignersAddressAsActiveAddress: boolean, currentSignerAddress: bigint | undefined = undefined) {
	return await browserStorageLocalSet({
		useSignersAddressAsActiveAddress,
		...useSignersAddressAsActiveAddress === true ? { activeSigningAddress: currentSignerAddress } : {}
	})
}

export async function changeSimulationMode(changes: { simulationMode: boolean, rpcNetwork?: RpcNetwork, activeSimulationAddress?: EthereumAddress, activeSigningAddress?: EthereumAddress }) {
	return await browserStorageLocalSet({
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { activeRpcNetwork: changes.rpcNetwork }: {},
		...'activeSimulationAddress' in changes ? { activeSimulationAddress: changes.activeSimulationAddress }: {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: changes.activeSigningAddress }: {},
	})
}

const websiteAccessSemaphore = new Semaphore(1)
async function getNormalizedWebsiteAccessFromStorage() {
	const rawWebsiteAccess = await getParsedStorageValueOrDefault('websiteAccess', [])
	const sanitizedWebsiteAccess = sanitizeWebsiteAccess(rawWebsiteAccess)
	return { rawWebsiteAccess, sanitizedWebsiteAccess }
}

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
}

export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const { rawWebsiteAccess, sanitizedWebsiteAccess } = await getNormalizedWebsiteAccessFromStorage()
		const nextWebsiteAccess = sanitizeWebsiteAccess(updateFunc(sanitizedWebsiteAccess))
		if (nextWebsiteAccess === sanitizedWebsiteAccess && rawWebsiteAccess === sanitizedWebsiteAccess) return
		return await browserStorageLocalSet({ websiteAccess: nextWebsiteAccess })
	})
}

export async function updateKnownWebsiteMetadata(website: Website) {
	await updateWebsiteAccess((previousWebsiteAccess) => {
		let changed = false
		const nextWebsiteAccess = previousWebsiteAccess.map((entry) => {
			if (entry.website.websiteOrigin !== website.websiteOrigin) return entry
			const mergedWebsite = mergeStoredWebsiteMetadata(entry.website, website)
			if (mergedWebsite === entry.website) return entry
			changed = true
			return { ...entry, website: mergedWebsite }
		})
		return changed ? nextWebsiteAccess : previousWebsiteAccess
	})
}

export const getUseTabsInsteadOfPopup = async() => (await browserStorageLocalGet('useTabsInsteadOfPopup'))?.useTabsInsteadOfPopup ?? false
export const setUseTabsInsteadOfPopup = async(useTabsInsteadOfPopup: boolean) => await browserStorageLocalSet({ useTabsInsteadOfPopup })

export const getMetamaskCompatibilityMode = async() => (await browserStorageLocalGet('metamaskCompatibilityMode'))?.metamaskCompatibilityMode ?? false
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
			rpcNetwork: settings.activeRpcNetwork,
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
	if (exportedSetings.version !== '1.0' && exportedSetings.version !== '1.1') {
		await setMetamaskCompatibilityMode(exportedSetings.settings.metamaskCompatibilityMode)
	}
	if (exportedSetings.version === '1.4') {
		await updateUserAddressBookEntries(() => exportedSetings.settings.addressBookEntries)
	} else {
		await updateUserAddressBookEntries((previousEntries) => {
			const convertActiveAddressToAddressBookEntry = (info: ActiveAddress): AddressBookEntry => ({ ...info, type: 'contact' as const, useAsActiveAddress: true, entrySource: 'User' as const })
			return getUniqueItemsByProperties(previousEntries.concat(exportedSetings.settings.addressInfos.map((x) => convertActiveAddressToAddressBookEntry(x))).concat(exportedSetings.settings.contacts ?? []), ['address'])
		})
	}
}

export const setPreSimulationBlockTimeManipulation = async (preSimulationBlockTimeManipulation: BlockTimeManipulation) => await browserStorageLocalSet({ preSimulationBlockTimeManipulation })
export const getPreSimulationBlockTimeManipulation = async() => (await browserStorageLocalGet('preSimulationBlockTimeManipulation'))?.preSimulationBlockTimeManipulation ?? DEFAULT_BLOCK_MANIPULATION
