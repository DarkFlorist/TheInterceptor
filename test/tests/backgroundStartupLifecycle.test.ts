import * as assert from 'assert'
import { describe, test } from 'bun:test'

const backgroundStartupModuleUrl = new URL('../../app/ts/background/background-startup.ts', import.meta.url).href
const settingsModuleUrl = new URL('../../app/ts/background/settings.js', import.meta.url).href
const backgroundModuleUrl = new URL('../../app/ts/background/background.js', import.meta.url).href
const iconHandlerModuleUrl = new URL('../../app/ts/background/iconHandler.js', import.meta.url).href
const storageVariablesModuleUrl = new URL('../../app/ts/background/storageVariables.js', import.meta.url).href
const backgroundUtilsModuleUrl = new URL('../../app/ts/background/backgroundUtils.js', import.meta.url).href
const subscriptionModuleUrl = new URL('../../app/ts/simulation/services/EthereumSubscriptionService.js', import.meta.url).href
const requestsModuleUrl = new URL('../../app/ts/utils/requests.js', import.meta.url).href
const errorsModuleUrl = new URL('../../app/ts/utils/errors.js', import.meta.url).href
const contentScriptsUpdatingModuleUrl = new URL('../../app/ts/utils/contentScriptsUpdating.js', import.meta.url).href
const sleepingModuleUrl = new URL('../../app/ts/background/sleeping.js', import.meta.url).href
const uiUtilsModuleUrl = new URL('../../app/ts/components/ui-utils.js', import.meta.url).href
const confirmTransactionModuleUrl = new URL('../../app/ts/background/windows/confirmTransaction.js', import.meta.url).href
const typescriptUtilsModuleUrl = new URL('../../app/ts/utils/typescript.js', import.meta.url).href
const storageUtilsModuleUrl = new URL('../../app/ts/utils/storageUtils.js', import.meta.url).href
const typedArraysModuleUrl = new URL('../../app/ts/utils/typed-arrays.js', import.meta.url).href
const accessManagementModuleUrl = new URL('../../app/ts/background/accessManagement.js', import.meta.url).href
const popupVisualisationModuleUrl = new URL('../../app/ts/background/popupVisualisationUpdater.js', import.meta.url).href
const popupPerformanceModuleUrl = new URL('../../app/ts/utils/popupPerformance.js', import.meta.url).href
const websiteTabConnectionsModuleUrl = new URL('../../app/ts/background/websiteTabConnections.js', import.meta.url).href
const serviceLifecycleModuleUrl = new URL('../../app/ts/simulation/serviceLifecycle.js', import.meta.url).href

describe('background startup lifecycle', () => {
	test('ignores invalidated connect ports before listeners can be attached', () => {
		const script = `
			import { mock } from 'bun:test'

			let onConnectListener
			const handledUnexpectedErrors = []
			const originalSetTimeout = globalThis.setTimeout

			globalThis.setTimeout = (() => 0)
			globalThis.browser = {
				runtime: {
					lastError: null,
					async sendMessage() {
						return undefined
					},
					getManifest: () => ({ manifest_version: 3 }),
					onMessage: { addListener: () => undefined, removeListener: () => undefined },
					onConnect: {
						addListener: (listener) => {
							onConnectListener = listener
						},
						removeListener: () => undefined,
					},
				},
				tabs: {
					async query() { return [] },
					async get() { return undefined },
					async update() { return undefined },
					onUpdated: { addListener: () => undefined, removeListener: () => undefined },
					onRemoved: { addListener: () => undefined, removeListener: () => undefined },
				},
				windows: {
					async get() { return undefined },
					async update() { return undefined },
				},
				storage: {
					local: {
						async get() { return {} },
						async set() { return undefined },
						async remove() { return undefined },
					},
				},
				action: {
					async setIcon() { return undefined },
					async setTitle() { return undefined },
					async setBadgeText() { return undefined },
					async setBadgeBackgroundColor() { return undefined },
				},
				browserAction: {
					async setIcon() { return undefined },
					async setTitle() { return undefined },
					async setBadgeText() { return undefined },
					async setBadgeBackgroundColor() { return undefined },
				},
			}
			globalThis.chrome = { runtime: { id: 'test-extension' } }

			mock.module(${ JSON.stringify(settingsModuleUrl) }, () => ({
				defaultRpcs: [{
					name: 'Ethereum Mainnet',
					chainId: 1n,
					httpsRpc: 'https://ethereum.dark.florist',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					currencyLogoUri: '../img/ethereum.svg',
					primary: true,
					minimized: true,
				}],
				getSettings: async () => ({
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
					simulationMode: false,
					websiteAccess: [],
				}),
			}))
			mock.module(${ JSON.stringify(backgroundModuleUrl) }, () => ({
				getUpdatedSimulationState: () => undefined,
				handleInterceptedRequest: async () => undefined,
				popupMessageHandler: async () => undefined,
			}))
			mock.module(${ JSON.stringify(iconHandlerModuleUrl) }, () => ({
				retrieveWebsiteDetails: async () => ({ icon: undefined, title: undefined }),
				updateExtensionBadge: async () => undefined,
				updateExtensionIcon: async () => undefined,
			}))
			mock.module(${ JSON.stringify(storageVariablesModuleUrl) }, () => ({
				clearTabStates: () => undefined,
				getPrimaryRpcForChain: async () => undefined,
				removeTabState: async () => undefined,
				setRpcConnectionStatus: async () => undefined,
				updateTabState: async () => undefined,
				updateUserAddressBookEntries: async () => undefined,
				updateUserAddressBookEntriesV2Old: async () => undefined,
			}))
			mock.module(${ JSON.stringify(backgroundUtilsModuleUrl) }, () => ({
				getSocketFromPort: () => ({ tabId: 1, connectionName: 0n }),
				sendPopupMessageToOpenWindows: async () => undefined,
				websiteSocketToString: () => '1-0',
			}))
			mock.module(${ JSON.stringify(subscriptionModuleUrl) }, () => ({
				sendSubscriptionMessagesForNewBlock: async () => undefined,
			}))
			mock.module(${ JSON.stringify(requestsModuleUrl) }, () => ({
				RawInterceptedRequest: { parse: (value) => value },
				checkAndThrowRuntimeLastError: () => undefined,
				getHostWithPort: () => 'example.test',
				silenceChromeUnCaughtPromise: async (maybeAwaitedFunction) => await maybeAwaitedFunction,
			}))
			mock.module(${ JSON.stringify(errorsModuleUrl) }, () => ({
				handleUnexpectedError: (error) => {
					handledUnexpectedErrors.push(error)
				},
				isNewBlockAbort: () => false,
				printError: () => undefined,
			}))
			mock.module(${ JSON.stringify(contentScriptsUpdatingModuleUrl) }, () => ({
				updateContentScriptInjectionStrategyManifestV2: () => undefined,
			}))
			mock.module(${ JSON.stringify(sleepingModuleUrl) }, () => ({
				checkIfInterceptorShouldSleep: async () => undefined,
			}))
			mock.module(${ JSON.stringify(uiUtilsModuleUrl) }, () => ({
				addWindowTabListeners: () => undefined,
			}))
			mock.module(${ JSON.stringify(confirmTransactionModuleUrl) }, () => ({
				onCloseWindowOrTab: async () => undefined,
			}))
			mock.module(${ JSON.stringify(typescriptUtilsModuleUrl) }, () => ({
				modifyObject: (value) => value,
			}))
			mock.module(${ JSON.stringify(storageUtilsModuleUrl) }, () => ({
				browserStorageLocalGet: async () => ({}),
				browserStorageLocalRemove: async () => undefined,
			}))
			mock.module(${ JSON.stringify(typedArraysModuleUrl) }, () => ({
				getUniqueItemsByProperties: (values) => values,
			}))
			mock.module(${ JSON.stringify(accessManagementModuleUrl) }, () => ({
				updateDeclarativeNetRequestBlocks: async () => undefined,
			}))
			mock.module(${ JSON.stringify(popupVisualisationModuleUrl) }, () => ({
				updatePopupVisualisationIfNeeded: async () => undefined,
			}))
			mock.module(${ JSON.stringify(popupPerformanceModuleUrl) }, () => ({
				POPUP_PERFORMANCE_MARKS: { backgroundStartupReady: 'backgroundStartupReady' },
				markPerformance: () => undefined,
			}))
			mock.module(${ JSON.stringify(websiteTabConnectionsModuleUrl) }, () => ({
				removeWebsiteTabConnection: () => undefined,
			}))
			mock.module(${ JSON.stringify(serviceLifecycleModuleUrl) }, () => ({
				createSimulationServices: () => ({ ethereum: {}, tokenPriceService: {} }),
				resetSimulationServices: (services) => services,
			}))

			try {
				await import(${ JSON.stringify(backgroundStartupModuleUrl) })
				if (typeof onConnectListener !== 'function') throw new Error('onConnect listener was not registered')
				await onConnectListener({
					name: '0x0',
					sender: { url: 'https://example.test', tab: { id: 1 } },
					get onDisconnect() {
						throw new Error("Failed to read the 'onDisconnect' property from 'Object': Extension context invalidated.")
					},
				})
				if (handledUnexpectedErrors.length !== 0) throw new Error('invalidated port was reported as unexpected')
			} finally {
				globalThis.setTimeout = originalSetTimeout
			}
		`

		const result = Bun.spawnSync({
			cmd: [process.execPath, '--eval', script],
			cwd: new URL('../../', import.meta.url).pathname,
			stdout: 'pipe',
			stderr: 'pipe',
		})

		assert.equal(
			result.exitCode,
			0,
			`child process failed:\nstdout:\n${ result.stdout.toString() }\nstderr:\n${ result.stderr.toString() }`,
		)
	})
})
