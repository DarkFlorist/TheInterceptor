import 'webextension-polyfill'
import { defaultRpcs, getMakeMeRich, getSettings } from './settings.js'
import { getPrependTrasactions, handleInterceptedRequest, popupMessageHandler, updateSimulationState } from './background.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { clearTabStates, getPrimaryRpcForChain, getSimulationResults, removeTabState, setRpcConnectionStatus, updateTabState } from './storageVariables.js'
import { setPrependTransactionsQueue } from '../simulation/services/SimulationModeEthereumClientService.js'
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
import { printError } from '../utils/errors.js'

const websiteTabConnections = new Map<number, TabConnection>()

browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

export async function onContentScriptConnected(simulator: Simulator, port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const websitePromise = retrieveWebsiteDetails(port, websiteOrigin)
	const identifier = websiteSocketToString(socket)

	const tabConnection = websiteTabConnections.get(socket.tabId)
	const newConnection = {
		port: port,
		socket: socket,
		websiteOrigin: websiteOrigin,
		approved: false,
		wantsToConnect: false,
	}
	port.onDisconnect.addListener(() => {
		const tabConnection = websiteTabConnections.get(socket.tabId)
		if (tabConnection === undefined) return
		delete tabConnection.connections[websiteSocketToString(socket)]
		if (Object.keys(tabConnection).length === 0) {
			websiteTabConnections.delete(socket.tabId)
		}
	})

	const pendingRequestLimiter = new Semaphore(20) // only allow 20 requests pending at the time for a port

	port.onMessage.addListener(async (payload) => {
		if (!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
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
	})

	if (tabConnection === undefined) {
		websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return {
				...previousState,
				tabIconDetails: {
					icon: ICON_NOT_ACTIVE,
					iconReason: 'No active address selected.',
				}
			}
		})
		updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}
}

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean, simulator: Simulator) {
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
			await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode ? await refreshSimulation(simulator, ethereumClientService, settings) : undefined, websiteTabConnections)
		}
	} catch(error) {
		printError(error)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService) {
	try {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getLastKnownCachedBlockOrUndefined(),
			rpcNetwork: ethereumClientService.getRpcEntry(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		return await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	} catch(error) {
		printError(error)
	}
}

async function startup() {
	const settings = await getSettings()
	const userSpecifiedSimulatorNetwork = settings.rpcNetwork.httpsRpc === undefined ? await getPrimaryRpcForChain(1n) : settings.rpcNetwork
	const simulatorNetwork = userSpecifiedSimulatorNetwork === undefined ? defaultRpcs[0] : userSpecifiedSimulatorNetwork
	const simulator = new Simulator(simulatorNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	browser.runtime.onConnect.addListener(port => onContentScriptConnected(simulator, port, websiteTabConnections).catch(console.error))
	browser.runtime.onMessage.addListener(async function (message: unknown) {
		await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
	})

	await updateExtensionBadge()

	if (settings.simulationMode) {
		// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		const ethereumClientService = simulator.ethereum
		await updateSimulationState(simulator.ethereum, async () => {
			const simulationState = (await getSimulationResults()).simulationState
			const prependQueue = await getPrependTrasactions(ethereumClientService, settings, await getMakeMeRich())
			return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
		}, settings.activeSimulationAddress, true)
	}
}

startup()
