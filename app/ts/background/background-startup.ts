import 'webextension-polyfill'
import { defaultRpcs, getSettings, updateKnownWebsiteMetadata } from './settings.js'
import { getUpdatedSimulationState, handleInterceptedRequest, popupMessageHandler } from './background.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { clearTabStates, getPrimaryRpcForChain, removeTabState, setRpcConnectionStatus, updateTabState } from './storageVariables.js'
import type { TabConnection, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumBlockHeader } from '../types/wire-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSocketFromPort, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { Semaphore } from '../utils/semaphore.js'
import { RawInterceptedRequest, checkAndThrowRuntimeLastError, getHostWithPort, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { DEFAULT_TAB_CONNECTION, ICON_NOT_ACTIVE } from '../utils/constants.js'
import { handleUnexpectedError, isNewBlockAbort, printError } from '../utils/errors.js'
import { updateContentScriptInjectionStrategyManifestV2 } from '../utils/contentScriptsUpdating.js'
import { checkIfInterceptorShouldSleep } from './sleeping.js'
import { onCloseWindowOrTab } from './windows/confirmTransaction.js'
import { modifyObject } from '../utils/typescript.js'
import { updateDeclarativeNetRequestBlocks } from './accessManagement.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../utils/popupPerformance.js'
import { removeWebsiteTabConnection } from './websiteTabConnections.js'
import { createSimulationServices, resetSimulationServices, type ResetSimulationServices, type SimulationServices } from '../simulation/serviceLifecycle.js'
import { addWindowTabListeners } from '../utils/popupOrTab.js'
import { migrateAddressBook } from './addressBookMigration.js'

const websiteTabConnections = new Map<number, TabConnection>()
let simulationServices: SimulationServices | undefined
let resetActiveRpcNetwork: ResetSimulationServices | undefined

function getSimulationServices() {
	if (simulationServices === undefined) throw new Error('Simulation services are not initialized')
	return simulationServices
}

const catchAllErrorsAndCall = async (func: () => Promise<unknown>) => {
	try {
		const reply = await func()
		checkAndThrowRuntimeLastError()
		return reply
	} catch(error: unknown) {
		if (error instanceof Error) {
			if (error.message.startsWith('No tab with id')) return
			if (error.message.includes('the message channel is closed')) {
				// ignore bfcache error. It means that the page is hibernating and we cannot communicate with it anymore. We get a normal disconnect about it.
				// https://developer.chrome.com/blog/bfcache-extension-messaging-changes
				return
			}
			if (error.message.includes('The message port closed before a response was received')) return
			if (error.message.includes('Could not establish connection. Receiving end does not exist')) return
			if (error.message.includes('Failed to fetch')) return
			if (isNewBlockAbort(error)) return
		}
		console.error(error)
		handleUnexpectedError(error)
	}
	return undefined
}

browser.tabs.onRemoved.addListener(async (tabId: number) => await catchAllErrorsAndCall(() => removeTabState(tabId)))

if (browser.runtime.getManifest().manifest_version === 2) {
	updateContentScriptInjectionStrategyManifestV2()
	clearTabStates()
}

const pendingRequestLimiter = new Semaphore(40) // only allow 40 requests pending globally

async function onContentScriptConnected(getCurrentSimulationServices: () => SimulationServices, resetActiveRpcNetwork: ResetSimulationServices, port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined || socket === undefined) {
		printError(`Could not connect to a port: ${ port.name}`)
		return
	}
	const websiteOrigin = getHostWithPort(port.sender.url)
	const identifier = websiteSocketToString(socket)
	const websitePromise = (async () => {
		const website = { websiteOrigin, ...await retrieveWebsiteDetails(socket.tabId, websiteOrigin) }
		await updateKnownWebsiteMetadata(website)
		return website
	})()
	silenceChromeUnCaughtPromise(websitePromise)

	const tabConnection = websiteTabConnections.get(socket.tabId)
	const newConnection = { port, socket, websiteOrigin, approved: false, wantsToConnect: false }

	port.onDisconnect.addListener(() => {
		catchAllErrorsAndCall(async () => {
			removeWebsiteTabConnection(websiteTabConnections, socket)
		})
		try {
			checkAndThrowRuntimeLastError()
		} catch (error) {
			if (error instanceof Error) {
				if (error.message?.includes('the message channel is closed')) {
					// ignore bfcache error. It means that the page is hibernating and we cannot communicate with it anymore. We get a normal disconnect about it.
					// https://developer.chrome.com/blog/bfcache-extension-messaging-changes
					return
				}
			}
			throw error
		}
	})

	port.onMessage.addListener((payload) => {
		catchAllErrorsAndCall(async () => {
			if (!(
				'data' in payload
				&& typeof payload.data === 'object'
				&& payload.data !== null
				&& 'interceptorRequest' in payload.data
			)) return
				await pendingRequestLimiter.execute(async () => {
					const rawMessage = RawInterceptedRequest.parse(payload.data)
					const { ethereum, tokenPriceService } = getCurrentSimulationServices()
					const request = {
						method: rawMessage.method,
					...'params' in rawMessage ? { params: rawMessage.params } : {},
						interceptorRequest: rawMessage.interceptorRequest,
						usingInterceptorWithoutSigner: rawMessage.usingInterceptorWithoutSigner,
						uniqueRequestIdentifier: { requestId: rawMessage.requestId, requestSocket: socket },
						...(rawMessage.interceptorInternalRequest === true ? { interceptorInternalRequest: true as const } : {}),
					}
					return await handleInterceptedRequest(port, websiteOrigin, websitePromise, ethereum, tokenPriceService, resetActiveRpcNetwork, socket, request, websiteTabConnections)
				})
			})
		})

	if (tabConnection === undefined) {
		websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return modifyObject(previousState, {
				website: { websiteOrigin, icon: undefined, title: undefined },
				tabIconDetails: { icon: ICON_NOT_ACTIVE, iconReason: 'No active address selected.' },
			})
		})
		updateExtensionIcon(websiteTabConnections, socket.tabId, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}
	try {
		const website = await websitePromise
		await updateTabState(socket.tabId, (previousState: TabState) => modifyObject(previousState, { website }))
		checkAndThrowRuntimeLastError()
	} catch(error: unknown) {
		console.error(error)
		if (error instanceof Error && error.message.startsWith('No tab with id')) return
		await handleUnexpectedError(error)
	}
}

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) {
	if (ethereumClientService !== getSimulationServices().ethereum) return
	if (blockheader === null) throw new Error('The latest block is null')
	try {
		const rpcConnectionStatus = {
			isConnected: true,
			lastConnnectionAttempt: new Date(),
			latestBlock: blockheader,
			rpcNetwork: ethereumClientService.getRpcEntry(),
			retrying: ethereumClientService.isBlockPolling(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		if (isNewBlock) {
			const settings = await getSettings()
			if (settings.simulationMode) {
				const { ethereum, tokenPriceService } = getSimulationServices()
				const updatePopupVisualisationPromise = updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false)
				silenceChromeUnCaughtPromise(updatePopupVisualisationPromise)
				await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
				return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, getUpdatedSimulationState)
			}
			await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
			return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, websiteTabConnections, getUpdatedSimulationState)
		}
		await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
	} catch(error) {
		if (error instanceof Error && isNewBlockAbort(error)) return
		await handleUnexpectedError(error)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService, _error: unknown) {
	if (ethereumClientService !== getSimulationServices().ethereum) return
	try {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getCachedBlock(),
			rpcNetwork: ethereumClientService.getRpcEntry(),
			retrying: ethereumClientService.isBlockPolling(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	} catch(error) {
		await handleUnexpectedError(error)
	}
}

async function startup() {
	await migrateAddressBook()
	const settings = await getSettings()
	const userSpecifiedSimulatorNetwork = settings.activeRpcNetwork.httpsRpc === undefined ? await getPrimaryRpcForChain(1n) : settings.activeRpcNetwork
	const simulatorNetwork = userSpecifiedSimulatorNetwork === undefined ? defaultRpcs[0] : userSpecifiedSimulatorNetwork
	simulationServices = createSimulationServices(simulatorNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	resetActiveRpcNetwork = (rpcNetwork) => {
		simulationServices = resetSimulationServices(getSimulationServices(), rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	}
	const recursiveCheckIfInterceptorShouldSleep = async () => {
		await catchAllErrorsAndCall(async () => checkIfInterceptorShouldSleep(getSimulationServices().ethereum))
		setTimeout(recursiveCheckIfInterceptorShouldSleep, 1000)
	}

	recursiveCheckIfInterceptorShouldSleep()

	await updateExtensionBadge()
	await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundStartupReady)
}

const backgroundStartupPromise = startup()

async function waitForBackgroundStartup() {
	await backgroundStartupPromise
	const currentResetActiveRpcNetwork = resetActiveRpcNetwork
	if (currentResetActiveRpcNetwork === undefined) throw new Error('Background startup reset handler is not initialized')
	return {
		resetActiveRpcNetwork: currentResetActiveRpcNetwork,
		simulationServices: getSimulationServices(),
	}
}

const onTabUpdated = async (tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => await catchAllErrorsAndCall(async () => {
	await waitForBackgroundStartup()
	if (changeInfo.status !== 'complete') return
	if (tab.url === undefined) return
	const websiteOrigin = getHostWithPort(tab.url)
	const website = { websiteOrigin, ...await retrieveWebsiteDetails(tabId, websiteOrigin) }
	await updateKnownWebsiteMetadata(website)
	await updateTabState(tabId, (previousState: TabState) => modifyObject(previousState, { website, tabIconDetails: DEFAULT_TAB_CONNECTION }))
	await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	await updateExtensionIcon(websiteTabConnections, tabId, websiteOrigin)
})

const onCloseWindow = async (id: number) => await catchAllErrorsAndCall(async () => {
	const { simulationServices } = await waitForBackgroundStartup()
	return await onCloseWindowOrTab({ type: 'popup' as const, id }, simulationServices.ethereum, simulationServices.tokenPriceService, websiteTabConnections)
})

const onCloseTab = async (id: number) => await catchAllErrorsAndCall(async () => {
	const { simulationServices } = await waitForBackgroundStartup()
	return await onCloseWindowOrTab({ type: 'tab' as const, id }, simulationServices.ethereum, simulationServices.tokenPriceService, websiteTabConnections)
})

// MV3 service worker event listeners must be registered synchronously at module load.
browser.tabs.onUpdated.addListener(onTabUpdated)
browser.runtime.onConnect.addListener((port) => catchAllErrorsAndCall(async () => {
	const { resetActiveRpcNetwork } = await waitForBackgroundStartup()
	return await onContentScriptConnected(getSimulationServices, resetActiveRpcNetwork, port, websiteTabConnections)
}))
browser.runtime.onMessage.addListener((message: unknown) => Promise.resolve(catchAllErrorsAndCall(async () => {
	const { simulationServices, resetActiveRpcNetwork } = await waitForBackgroundStartup()
	return await popupMessageHandler(websiteTabConnections, simulationServices.ethereum, simulationServices.tokenPriceService, resetActiveRpcNetwork, message, await getSettings())
})))
addWindowTabListeners(onCloseWindow, onCloseTab)
