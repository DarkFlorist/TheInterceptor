import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'

Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
Reflect.set(globalThis, 'browser', {
	runtime: {
		lastError: undefined,
		getManifest: () => ({ manifest_version: 3 }),
		onMessage: { addListener: () => undefined, removeListener: () => undefined },
		onConnect: { addListener: () => undefined, removeListener: () => undefined },
	},
})

const [
	{ dispatchPopupMessage },
	{ EthereumClientService: EthereumClientServiceConstructor },
	{ TokenPriceService: TokenPriceServiceConstructor },
] = await Promise.all([
	import('../../app/ts/background/popupMessageDispatcher.js'),
	import('../../app/ts/simulation/services/EthereumClientService.js'),
	import('../../app/ts/simulation/services/priceEstimator.js'),
])

const settings: Settings = {
	activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	activeRpcNetwork: {
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://ethereum.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: '../img/ethereum.svg',
		primary: true,
		minimized: true,
	},
	simulationMode: true,
}

function createDispatcherContext(resetSimulationState: () => Promise<void>): PopupMessageDispatcherContext {
	const ethereum: EthereumClientService = Object.create(EthereumClientServiceConstructor.prototype)
	const tokenPriceService: TokenPriceService = Object.create(TokenPriceServiceConstructor.prototype)
	return {
		websiteTabConnections: new Map(),
		ethereum,
		tokenPriceService,
		resetSimulationServices: () => undefined,
		settings,
		publishRpcConnectionStatus: async () => undefined,
		simulationAbortController: new AbortController(),
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState,
	}
}

describe('popup message dispatcher seams', () => {
	test('delegates simulation reset through the injected lifecycle callback', async () => {
		let resetCount = 0
		const result = await dispatchPopupMessage(createDispatcherContext(async () => {
			resetCount += 1
		}), { method: 'popup_resetSimulation' })
		assert.equal(result, undefined)
		assert.equal(resetCount, 1)
	})

	test('deliberately ignores popup window status probes handled by window listeners', async () => {
		const context = createDispatcherContext(async () => {
			throw new Error('Window status probes must not reset simulation state.')
		})
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isMainPopupWindowOpen' }), undefined)
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isSimulationVisualizerOpen' }), undefined)
	})
})
