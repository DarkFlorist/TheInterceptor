import 'webextension-polyfill'
import { getMakeMeRich, getSettings } from './settings.js'
import { gateKeepRequestBehindAccessDialog, getPrependTrasactions, handleContentScriptMessage, popupMessageHandler, refuseAccess, updateSimulationState } from './background.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { clearTabStates, getSimulationResults, removeTabState, setRpcConnectionStatus, updateTabState } from './storageVariables.js'
import { setPrependTransactionsQueue } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Simulator } from '../simulation/simulator.js'
import { TabConnection, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { EthereumBlockHeader } from '../utils/wire-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getActiveAddress, getSocketFromPort, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { refreshSimulation } from './popupMessageHandlers.js'
import { isFailedToFetchError } from '../utils/errors.js'
import { Semaphore } from '../utils/semaphore.js'
import { RawInterceptedRequest } from '../utils/requests.js'
import { verifyAccess } from './accessManagement.js'
import { InpageScriptRequest, TabState } from '../utils/interceptor-messages.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { assertNever } from '../utils/typescript.js'
import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'

const websiteTabConnections = new Map<number, TabConnection>()

browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

function getProviderHandler(method: string) {
	switch (method) {
		case 'eth_accounts_reply': return { method: 'eth_accounts_reply' as const, func: ethAccountsReply }
		case 'signer_chainChanged': return { method: 'signer_chainChanged' as const, func: signerChainChanged }
		case 'wallet_switchEthereumChain_reply': return { method: 'wallet_switchEthereumChain_reply' as const, func: walletSwitchEthereumChainReply }
		case 'connected_to_signer': return { method: 'connected_to_signer' as const, func: connectedToSigner }
		default: return { method: 'notProviderMethod' as const }
	}
}

export async function onContentScriptConnected(simulator: Simulator, port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const websitePromise = retrieveWebsiteDetails(port, websiteOrigin)
	const identifier = websiteSocketToString(socket)

	console.log(`content script connected ${ websiteOrigin }`)

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
			const activeAddress = await getActiveAddress(await getSettings(), socket.tabId)
			const access = verifyAccess(websiteTabConnections, socket, request.method === 'eth_requestAccounts', websiteOrigin, activeAddress, await getSettings())
			const providerHandler = getProviderHandler(request.method)
			const identifiedMethod = providerHandler.method
			if (identifiedMethod !== 'notProviderMethod') {
				await providerHandler.func(simulator, websiteTabConnections, port, request, access)
				const message: InpageScriptRequest = {
					uniqueRequestIdentifier: request.uniqueRequestIdentifier,
					method: identifiedMethod,
					result: '0x' as const,
				}
				return replyToInterceptedRequest(websiteTabConnections, message)
			}
			if (access === 'noAccess' || activeAddress === undefined) {
				if (request.method === 'eth_accounts') {
					return replyToInterceptedRequest(websiteTabConnections, { method: 'eth_accounts' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
				}
				// if user has not given access, assume we are on chain 1
				if (request.method === 'eth_chainId' || request.method === 'net_version') {
					return replyToInterceptedRequest(websiteTabConnections, { method: 'eth_chainId' as const, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
				}
			}

			switch (access) {
				case 'askAccess': return await gateKeepRequestBehindAccessDialog(simulator, websiteTabConnections, socket, request, await websitePromise, activeAddress, await getSettings())
				case 'noAccess': return refuseAccess(websiteTabConnections, request)
				case 'hasAccess': {
					if (activeAddress === undefined) return refuseAccess(websiteTabConnections, request)
					return await handleContentScriptMessage(simulator, websiteTabConnections, request, await websitePromise, activeAddress)
				}
				default: assertNever(access)
			}
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
	const rpcConnectionStatus = {
		isConnected: true,
		lastConnnectionAttempt: new Date(),
		latestBlock: blockheader,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
	}
	await setRpcConnectionStatus(rpcConnectionStatus)
	await updateExtensionBadge()
	await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
	if (isNewBlock) {
		const settings = await getSettings()
		await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode ? await refreshSimulation(simulator, ethereumClientService, settings) : undefined, websiteTabConnections)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService, error: Error) {
	if (isFailedToFetchError(error)) {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getLastKnownCachedBlockOrUndefined(),
			rpcNetwork: ethereumClientService.getRpcNetwork(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		return await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	}
	throw error
}

async function startup() {
	const settings = await getSettings()
	if (settings.rpcNetwork.httpsRpc === undefined) throw new Error('RPC not set')
	const simulator = new Simulator(settings.rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	browser.runtime.onConnect.addListener(port => onContentScriptConnected(simulator, port, websiteTabConnections).catch(console.error))
	browser.runtime.onMessage.addListener(async function (message: unknown) {
		await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
	})

	await updateExtensionBadge()

	if (settings.simulationMode) {
		try {
			// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
			const ethereumClientService = simulator.ethereum
			await updateSimulationState(simulator, async () => {
				const simulationState = (await getSimulationResults()).simulationState
				const prependQueue = await getPrependTrasactions(ethereumClientService, settings, await getMakeMeRich())
				return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
			}, settings.activeSimulationAddress, true)
		} catch(e) {
			console.error(e)
		}
	}
}

startup()
