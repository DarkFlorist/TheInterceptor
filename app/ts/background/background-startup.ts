import 'webextension-polyfill'
import { defaultRpcs, getSettings } from './settings.js'
import { handleInterceptedRequest, popupMessageHandler } from './background.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { clearTabStates, getPrimaryRpcForChain, removeTabState, setRpcConnectionStatus, updateTabState, updateUserAddressBookEntries } from './storageVariables.js'
import { Simulator } from '../simulation/simulator.js'
import { TabConnection, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumBlockHeader } from '../types/wire-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSocketFromPort, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { refreshSimulation } from './popupMessageHandlers.js'
import { Semaphore } from '../utils/semaphore.js'
import { RawInterceptedRequest } from '../utils/requests.js'
import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import { handleUnexpectedError } from '../utils/errors.js'
import { browserStorageLocalGet, browserStorageLocalRemove } from '../utils/storageUtils.js'
import { ActiveAddress, AddressBookEntries } from '../types/addressBookTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { updateContentScriptInjectionStrategyManifestV2 } from '../utils/contentScriptsUpdating.js'
import { checkIfInterceptorShouldSleep } from './sleeping.js'
import { addWindowTabListeners } from '../components/ui-utils.js'
import { onCloseWindowOrTab } from './windows/confirmTransaction.js'

const websiteTabConnections = new Map<number, TabConnection>()

browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	updateContentScriptInjectionStrategyManifestV2()
	clearTabStates()
}

async function migrateAddressInfoAndContacts() {
	const results = await browserStorageLocalGet(['addressInfos', 'contacts'])
	const convertActiveAddressToAddressBookEntry = (info: ActiveAddress) => ({ ...info, type: 'activeAddress' as const, entrySource: 'User' as const })
	const addressInfos: AddressBookEntries = (results.addressInfos ?? []).map((x) => convertActiveAddressToAddressBookEntry(x))
	const contacts: AddressBookEntries = results.contacts ?? []
	if (addressInfos.length > 0 || contacts.length > 0) {
		await updateUserAddressBookEntries((previousEntries) => {
			return getUniqueItemsByProperties(addressInfos.concat(contacts).concat(previousEntries), ['address'])
		})
		await browserStorageLocalRemove(['addressInfos', 'contacts'])
	}
}
migrateAddressInfoAndContacts()

const pendingRequestLimiter = new Semaphore(40) // only allow 40 requests pending globally

export async function onContentScriptConnected(simulator: Simulator, port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const identifier = websiteSocketToString(socket)
	const websitePromise = retrieveWebsiteDetails(socket.tabId, websiteOrigin)

	const tabConnection = websiteTabConnections.get(socket.tabId)
	const newConnection = {
		port: port,
		socket: socket,
		websiteOrigin: websiteOrigin,
		approved: false,
		wantsToConnect: false,
	}
	port.onDisconnect.addListener(() => {
		try {
			const tabConnection = websiteTabConnections.get(socket.tabId)
			if (tabConnection === undefined) return
			delete tabConnection.connections[websiteSocketToString(socket)]
			if (Object.keys(tabConnection).length === 0) {
				websiteTabConnections.delete(socket.tabId)
			}
		} catch(error: unknown) {
			handleUnexpectedError(error)
		}
	})

	port.onMessage.addListener(async (payload) => {
		if (!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		try {
			await pendingRequestLimiter.execute(async () => {
				const rawMessage = RawInterceptedRequest.parse(payload.data)
				const request = {
					method: rawMessage.method,
					...'params' in rawMessage ? { params: rawMessage.params } : {},
					interceptorRequest: rawMessage.interceptorRequest,
					usingInterceptorWithoutSigner: rawMessage.usingInterceptorWithoutSigner,
					uniqueRequestIdentifier: { requestId: rawMessage.requestId, requestSocket: socket },
				}
				return await handleInterceptedRequest(port, websiteOrigin, websitePromise, simulator, socket, request, websiteTabConnections)
			})
		} catch(error: unknown) {
			await handleUnexpectedError(error)
		}
	})

	if (tabConnection === undefined) {
		websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return {
				...previousState,
				website: { websiteOrigin, icon: undefined, title: undefined },
				tabIconDetails: { icon: ICON_NOT_ACTIVE, iconReason: 'No active address selected.' },
			}
		})
		updateExtensionIcon(socket.tabId, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}
	const website = await websitePromise
	await updateTabState(socket.tabId, (previousState: TabState) => ({ ...previousState, website }))
}

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean, simulator: Simulator) {
	if (ethereumClientService.getChainId() !== simulator.ethereum.getChainId()) throw new Error(`Chain Id Mismatch, node is on ${ ethereumClientService.getChainId() } while simulator is on ${ simulator.ethereum.getChainId() }`)
	try {
		const rpcConnectionStatus = {
			isConnected: true,
			lastConnnectionAttempt: new Date(),
			latestBlock: blockheader,
			rpcNetwork: ethereumClientService.getRpcEntry(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
		if (isNewBlock) {
			const settings = await getSettings()
			const simulationState = settings.simulationMode ? await refreshSimulation(simulator, settings, false) : undefined
			await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, simulationState, websiteTabConnections)
		}
	} catch(error) {
		await handleUnexpectedError(error)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService) {
	try {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getCachedBlock(),
			rpcNetwork: ethereumClientService.getRpcEntry(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	} catch(error) {
		await handleUnexpectedError(error)
	}
}

async function startup() {
	const settings = await getSettings()
	const userSpecifiedSimulatorNetwork = settings.currentRpcNetwork.httpsRpc === undefined ? await getPrimaryRpcForChain(1n) : settings.currentRpcNetwork
	const simulatorNetwork = userSpecifiedSimulatorNetwork === undefined ? defaultRpcs[0] : userSpecifiedSimulatorNetwork
	const simulator = new Simulator(simulatorNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		try {
			if (changeInfo.status !== 'complete') return
			if (tab.url === undefined) return
			const websiteOrigin = (new URL(tab.url)).hostname
			const website = await retrieveWebsiteDetails(tabId, websiteOrigin)
			await updateTabState(tabId, (previousState: TabState) => ({ ...previousState, website }))
			await updateExtensionIcon(tabId, websiteOrigin)
		} catch(error: unknown) {
			handleUnexpectedError(error)
		}
	})
	browser.runtime.onConnect.addListener((port) => {
		try {
			onContentScriptConnected(simulator, port, websiteTabConnections)
		} catch(error: unknown) {
			handleUnexpectedError(error)
		}
	})
	browser.runtime.onMessage.addListener(async function (message: unknown) {
		try {
			await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
		} catch(error: unknown) {
			await handleUnexpectedError(error)
		}
	})


	const recursiveCheckIfInterceptorShouldSleep = async () => {
		try {
			await checkIfInterceptorShouldSleep(simulator.ethereum)
		} catch(error: unknown) {
			await handleUnexpectedError(error)
		}
		setTimeout(recursiveCheckIfInterceptorShouldSleep, 1000)
	}

	recursiveCheckIfInterceptorShouldSleep()

	await updateExtensionBadge()

	const onCloseWindow = (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id }, simulator, websiteTabConnections)
	const onCloseTab = (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id }, simulator, websiteTabConnections)
	addWindowTabListeners(onCloseWindow, onCloseTab)
}

startup()
