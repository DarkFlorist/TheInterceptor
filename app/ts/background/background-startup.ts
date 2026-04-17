import 'webextension-polyfill'
import { defaultRpcs, getSettings } from './settings.js'
import { handleInterceptedRequest, popupMessageHandler } from './background.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { clearTabStates, getPrimaryRpcForChain, removeTabState, setRpcConnectionStatus, updateTabState, updateUserAddressBookEntries, updateUserAddressBookEntriesV2Old } from './storageVariables.js'
import { Simulator } from '../simulation/simulator.js'
import { TabState } from '../types/user-interface-types.js'
import { EthereumBlockHeader } from '../types/wire-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSocketFromPort, publishPopupMessageToOpenUiPorts } from './backgroundUtils.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { Semaphore } from '../utils/semaphore.js'
import { checkAndThrowRuntimeLastError, getHostWithPort, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import { handleUnexpectedError, isNewBlockAbort, printError } from '../utils/errors.js'
import { updateContentScriptInjectionStrategyManifestV2 } from '../utils/contentScriptsUpdating.js'
import { checkIfInterceptorShouldSleep } from './sleeping.js'
import { addWindowTabListeners } from '../components/ui-utils.js'
import { onCloseWindowOrTab, updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { modifyObject } from '../utils/typescript.js'
import { OldActiveAddressEntry, browserStorageLocalGet, browserStorageLocalRemove } from '../utils/storageUtils.js'
import { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { updateDeclarativeNetRequestBlocks } from './accessManagement.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { installDefaultUiRouter, isUiPort, onUiPortConnected } from './uiSessions.js'
import { UiRole } from '../messages/ui.js'
import { refreshHomeData, settingsOpened } from './popupMessageHandlers.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from './windows/fetchSimulationStack.js'
import { updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import { PAGE_RPC_REQUEST, PageRequestPayload, parsePageRequestEnvelope } from '../messages/page.js'
import { createRouter } from '../messaging/router.js'
import { PageSessionStore, createPageSessionStore } from './pageSessions.js'

const pageSessions = createPageSessionStore()

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

async function migrateAddressInfoAndContactsFromV1ToV2() {
	const userAddressBookEntries = (await browserStorageLocalGet(['userAddressBookEntries'])).userAddressBookEntries
	const convertOldActiveAddressToAddressBookEntry = (entry: AddressBookEntry | OldActiveAddressEntry): AddressBookEntry => {
		if (entry.type !== 'activeAddress') return entry
		return { ...entry, type: 'contact', useAsActiveAddress: true }
	}
	if (userAddressBookEntries === undefined) return
	const updated: AddressBookEntries = userAddressBookEntries.map(convertOldActiveAddressToAddressBookEntry)
	if (updated.length > 0) {
		await updateUserAddressBookEntriesV2Old((previousEntries) => getUniqueItemsByProperties(updated.concat(previousEntries), ['address']))
		await browserStorageLocalRemove(['userAddressBookEntries'])
	}
}
async function migrateAddressInfoAndContactsFromV2ToV3() {
	const userAddressBookEntries = (await browserStorageLocalGet(['userAddressBookEntriesV2'])).userAddressBookEntriesV2
	const convertOldActiveAddressToAddressBookEntry = (entry: AddressBookEntry): AddressBookEntry => {
		if (entry.chainId !== undefined) return entry
		if (entry.useAsActiveAddress === true && entry.type === 'contact') return { ...entry, chainId: 'AllChains' }
		return { ...entry, chainId: 1n }
	}
	if (userAddressBookEntries === undefined) return
	const updated: AddressBookEntries = userAddressBookEntries.map(convertOldActiveAddressToAddressBookEntry)
	if (updated.length > 0) {
		await updateUserAddressBookEntries((previousEntries) => getUniqueItemsByProperties(updated.concat(previousEntries), ['address', 'chainId']))
		await browserStorageLocalRemove(['userAddressBookEntriesV2'])
	}
}
async function migrateAddressBook() {
	await migrateAddressInfoAndContactsFromV1ToV2()
	await migrateAddressInfoAndContactsFromV2ToV3()
}
migrateAddressBook()

const pendingRequestLimiter = new Semaphore(40) // only allow 40 requests pending globally
const pageRequestRouter = createRouter<{
	port: browser.runtime.Port
	socket: ReturnType<typeof getSocketFromPort>
	websiteOrigin: string
	websitePromise: Promise<{ websiteOrigin: string, icon: string | undefined, title: string | undefined }>
	simulator: Simulator
	pageSessions: PageSessionStore
	requestId: number
}>()

pageRequestRouter.register<PageRequestPayload>(PAGE_RPC_REQUEST, async (context, payload) => {
	const socket = context.socket
	if (socket === undefined) return
	await pendingRequestLimiter.execute(async () => {
		const request = {
			method: payload.method,
			...'params' in payload ? { params: payload.params } : {},
			interceptorRequest: payload.interceptorRequest,
			usingInterceptorWithoutSigner: payload.usingInterceptorWithoutSigner,
			uniqueRequestIdentifier: { requestId: context.requestId, requestSocket: socket },
		}
		return await handleInterceptedRequest(context.port, context.websiteOrigin, context.websitePromise, context.simulator, socket, request, context.pageSessions)
	})
})

async function onContentScriptConnected(simulator: Simulator, port: browser.runtime.Port, pageSessions: PageSessionStore) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined || socket === undefined) {
		printError(`Could not connect to a port: ${ port.name}`)
		return
	}
	const websiteOrigin = getHostWithPort(port.sender.url)
	const websitePromise = (async () => ({ websiteOrigin, ...await retrieveWebsiteDetails(socket.tabId) }))()
	silenceChromeUnCaughtPromise(websitePromise)

	pageSessions.upsert({ port, socket, websiteOrigin, approved: false, wantsToConnect: false })

	port.onDisconnect.addListener(() => {
		catchAllErrorsAndCall(async () => {
			pageSessions.remove(socket)
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
			const message = parsePageRequestEnvelope(payload)
			if (message === undefined) return
			await pageRequestRouter.dispatch(message.action, {
				port,
				socket,
				websiteOrigin,
				websitePromise,
				simulator,
				pageSessions,
				requestId: message.id,
			}, message.payload)
		})
	})

	if (pageSessions.getByTabId(socket.tabId).length === 1) {
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return modifyObject(previousState, {
				website: { websiteOrigin, icon: undefined, title: undefined },
				tabIconDetails: { icon: ICON_NOT_ACTIVE, iconReason: 'No active address selected.' },
			})
		})
		updateExtensionIcon(pageSessions, socket.tabId, websiteOrigin)
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

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean, simulator: Simulator) {
	if (ethereumClientService.getChainId() !== simulator.ethereum.getChainId()) throw new Error(`Chain Id Mismatch, node is on ${ ethereumClientService.getChainId() } while simulator is on ${ simulator.ethereum.getChainId() }`)
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
				const updatePopupVisualisationPromise = updatePopupVisualisationIfNeeded(simulator, false, false)
				silenceChromeUnCaughtPromise(updatePopupVisualisationPromise)
				await publishPopupMessageToOpenUiPorts({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
				return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, pageSessions)
			}
			await publishPopupMessageToOpenUiPorts({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
			return await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode, pageSessions)
		}
		await publishPopupMessageToOpenUiPorts({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
	} catch(error) {
		if (error instanceof Error && isNewBlockAbort(error)) return
		await handleUnexpectedError(error)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService, _error: unknown) {
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
		await publishPopupMessageToOpenUiPorts({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	} catch(error) {
		await handleUnexpectedError(error)
	}
}

async function startup() {
	const settings = await getSettings()
	const userSpecifiedSimulatorNetwork = settings.activeRpcNetwork.httpsRpc === undefined ? await getPrimaryRpcForChain(1n) : settings.activeRpcNetwork
	const simulatorNetwork = userSpecifiedSimulatorNetwork === undefined ? defaultRpcs[0] : userSpecifiedSimulatorNetwork
	const simulator = new Simulator(simulatorNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	const pushSnapshotForRole = async (role: UiRole) => {
		switch (role) {
			case 'main':
				await refreshHomeData(simulator, false)
				return
			case 'settingsView':
			case 'addressBook':
			case 'websiteAccess':
				await settingsOpened()
				return
			case 'changeChain':
				await updateChainChangeViewWithPendingRequest()
				return
			case 'confirmTransaction':
				await updateConfirmTransactionView(simulator)
				return
			case 'fetchSimulationStack':
				await updateFetchSimulationStackRequestWithPendingRequest()
				return
			case 'interceptorAccess':
				await updateInterceptorAccessViewWithPendingRequests()
				return
			default:
				return
		}
	}
	installDefaultUiRouter(
		async (message) => await popupMessageHandler(pageSessions, simulator, message, await getSettings()),
		pushSnapshotForRole,
	)
	browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		await catchAllErrorsAndCall(async () => {
			if (changeInfo.status !== 'complete') return
			if (tab.url === undefined) return
			const websiteOrigin = getHostWithPort(tab.url)
			const website = { websiteOrigin, ...await retrieveWebsiteDetails(tabId) }
			await updateTabState(tabId, (previousState: TabState) => modifyObject(previousState, { website }))
			await updateDeclarativeNetRequestBlocks(pageSessions)
			await updateExtensionIcon(pageSessions, tabId, websiteOrigin)
		})
	})
	browser.runtime.onConnect.addListener((port) => catchAllErrorsAndCall(async () => {
			if (isUiPort(port)) {
				await onUiPortConnected(port)
				return
			}
		await onContentScriptConnected(simulator, port, pageSessions)
	}))

	const recursiveCheckIfInterceptorShouldSleep = async () => {
		await catchAllErrorsAndCall(async () => checkIfInterceptorShouldSleep(simulator.ethereum))
		setTimeout(recursiveCheckIfInterceptorShouldSleep, 1000)
	}

	recursiveCheckIfInterceptorShouldSleep()

	await updateExtensionBadge()

	const onCloseWindow = async (id: number) => await catchAllErrorsAndCall(async () => await onCloseWindowOrTab({ type: 'popup' as const, id }, simulator, pageSessions))
	const onCloseTab = async (id: number) => await catchAllErrorsAndCall(async () => await onCloseWindowOrTab({ type: 'tab' as const, id }, simulator, pageSessions))
	addWindowTabListeners(onCloseWindow, onCloseTab)
	await updateDeclarativeNetRequestBlocks(pageSessions)
}

startup()
