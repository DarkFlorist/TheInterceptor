import { HandleSimulationModeReturnValue, InterceptedRequest, InterceptedRequestForward, PopupMessage, ProviderMessage, Settings, TabState, UserAddressBook } from '../utils/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { EthereumJsonRpcRequest, EthereumQuantity, EthereumUnsignedTransaction, PersonalSignParams, SignTypedDataParams } from '../utils/wire-types.js'
import { clearTabStates, getMakeMeRich, getSettings, getSignerName, getSimulationResults, removeTabState, setActiveChain, setActiveSigningAddress, setActiveSimulationAddress, updateSimulationResults, updateTabState } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, personalSign, requestPermissions, sendTransaction, subscribe, switchEthereumChain, unsubscribe } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveChain, enableSimulationMode, reviewNotification, rejectNotification, addOrModifyAddressInfo, getAddressBookData, removeAddressBookEntry, openAddressBook, homeOpened, interceptorAccessChangeAddressOrRefresh } from './popupMessageHandlers.js'
import { SimulationState } from '../utils/visualizer-types.js'
import { AddressBookEntry, Website, TabConnection, WebsiteSocket } from '../utils/user-interface-types.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { CHAINS, ICON_NOT_ACTIVE, isSupportedChain, MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { getActiveAddressForDomain, getAssociatedAddresses, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { findAddressInfo, getAddressBookEntriesForVisualiser } from './metadataUtils.js'
import { getActiveAddress, getSocketFromPort, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionIcon, websiteSocketToString } from './backgroundUtils.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { SimulationModeEthereumClientService } from '../simulation/services/SimulationModeEthereumClientService.js'
import { assertNever, assertUnreachable } from '../utils/typescript.js'

browser.runtime.onConnect.addListener(port => onContentScriptConnected(port).catch(console.error))
browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

let simulator: Simulator | undefined = undefined

declare global {
	var interceptor: {
		websiteTabConnections: Map<number, TabConnection>
	}
}

globalThis.interceptor = {
	websiteTabConnections: new Map(),
}

export async function updateSimulationState( getUpdatedSimulationState: () => Promise<SimulationState | undefined>, setAsActiveAddress: bigint | undefined = undefined) {
	if (simulator === undefined) return
	const settings = await getSettings()
	const activeSimAddress = settings.activeSimulationAddress
	const activeAddress = setAsActiveAddress === undefined ? activeSimAddress : setAsActiveAddress
	try {
		const simId = (await getSimulationResults()).simulationId + 1
		const updatedSimulationState = await getUpdatedSimulationState()

		if (updatedSimulationState !== undefined) {
			const priceEstimator = new PriceEstimator(simulator.ethereum)

			const transactions = updatedSimulationState.simulatedTransactions.map((x) => ({ ...x.signedTransaction, website: x.website }))
			const visualizerResult = await simulator.visualizeTransactionChain(transactions, updatedSimulationState.blockNumber, updatedSimulationState.simulatedTransactions.map( x => x.multicallResponse))
			const visualizerResultWithWebsites = visualizerResult.map((x,i) => ({ ...x, website: updatedSimulationState.simulatedTransactions[i].website }))
			const addressBookEntries = await getAddressBookEntriesForVisualiser(simulator, visualizerResult.map( (x) => x.visualizerResults), updatedSimulationState, settings.userAddressBook)

			function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry) : metadata is AddressBookEntry & { type: 'token', decimals: `0x${ string }` } {
				if (metadata.type !== 'token') return false
				if (metadata.decimals === undefined) return false
				return true
			}
			function metadataRestructure(metadata: AddressBookEntry &  { type: 'token', decimals: bigint } ) {
				return { token: metadata.address, decimals: metadata.decimals }
			}
			const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))

			await updateSimulationResults({
				simulationId: simId,
				tokenPrices: tokenPrices,
				addressBookEntries: addressBookEntries,
				visualizerResults: visualizerResultWithWebsites,
				simulationState: updatedSimulationState,
				activeAddress: activeAddress,
			})
		} else {
			await updateSimulationResults({
				simulationId: simId,
				addressBookEntries: [],
				tokenPrices: [],
				visualizerResults: [],
				simulationState: updatedSimulationState,
				activeAddress: activeAddress,
			})
		}
		sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed' })
		return updatedSimulationState
	} catch(e) {
		throw e
	}
}

export function setEthereumNodeBlockPolling(enabled: boolean) {
	if (simulator === undefined) return
	simulator.ethereum.setBlockPolling(enabled)
}

export async function refreshConfirmTransactionSimulation(activeAddress: bigint, simulationMode: boolean, requestId: number, transactionToSimulate: EthereumUnsignedTransaction, website: Website, userAddressBook: UserAddressBook) {
	if (simulator === undefined) return undefined

	const priceEstimator = new PriceEstimator(simulator.ethereum)
	const newSimulator = simulator.simulationModeNode.copy()
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' })
	const appended = await newSimulator.appendTransaction({ ...transactionToSimulate, website: website })
	const transactions = appended.simulationState.simulatedTransactions.map(x => ({ ...x.signedTransaction, website: x.website }) )
	const visualizerResult = await simulator.visualizeTransactionChain(transactions, appended.simulationState.blockNumber, appended.simulationState.simulatedTransactions.map( x => x.multicallResponse))
	const addressMetadata = await getAddressBookEntriesForVisualiser(simulator, visualizerResult.map( (x) => x.visualizerResults), appended.simulationState, userAddressBook)
	const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(
		addressMetadata.map(
			(x) => x.type === 'token' && x.decimals !== undefined ? { token: x.address, decimals: x.decimals } : { token: 0x0n, decimals: 0x0n }
		).filter( (x) => x.token !== 0x0n )
	)

	return {
		method: 'popup_confirm_transaction_simulation_state_changed' as const,
		data: {
			requestId: requestId,
			transactionToSimulate: transactionToSimulate,
			simulationMode: simulationMode,
			simulationState: appended.simulationState,
			visualizerResults: visualizerResult,
			addressBookEntries: addressMetadata,
			tokenPrices: tokenPrices,
			activeAddress: activeAddress,
			signerName: await getSignerName(),
			website: website,
		}
	}
}

// returns true if simulation state was changed
export async function updatePrependMode(settings: Settings) {
	if (simulator === undefined) return false

	const richMode = await getMakeMeRich()

	if (!settings.simulationMode || !richMode) {
		await updateSimulationState(async () => await simulator?.simulationModeNode.setPrependTransactionsQueue([]))
		return true
	}

	const activeAddress = getActiveAddress(settings)
	const chainId = settings.activeChain.toString()
	if (!isSupportedChain(chainId)) return false
	if (activeAddress === undefined) return false
	await updateSimulationState(async () => {
		if (simulator === undefined) return undefined
		if (!isSupportedChain(chainId)) return undefined
		const queue = [{
			from: CHAINS[chainId].eth_donator,
			chainId: CHAINS[chainId].chainId,
			nonce: await simulator.ethereum.getTransactionCount(CHAINS[chainId].eth_donator),
			to: activeAddress,
			...MAKE_YOU_RICH_TRANSACTION
		} as const]
		return await simulator.simulationModeNode.setPrependTransactionsQueue(queue)
	}, activeAddress)
	return true
}

export async function appendTransactionToSimulator(transaction: EthereumUnsignedTransaction, website: Website) {
	if (simulator === undefined) return
	const simulationState = await updateSimulationState(async () => (await simulator?.simulationModeNode.appendTransaction({ ...transaction, website }))?.simulationState)
	return {
		signed: await SimulationModeEthereumClientService.mockSignTransaction(transaction),
		simulationState: simulationState,
	}
}

export async function personalSignWithSimulator(params: PersonalSignParams | SignTypedDataParams) {
	if ( simulator === undefined) return
	return await simulator.simulationModeNode.personalSign(params)
}

async function handleSimulationMode(simulator: Simulator, socket: WebsiteSocket, website: Website, request: InterceptedRequest, settings: Settings): Promise<HandleSimulationModeReturnValue> {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = EthereumJsonRpcRequest.parse(request.options)
	} catch (error) {
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	switch (parsedRequest.method) {
		case 'eth_getBlockByNumber': return await getBlockByNumber(simulator, parsedRequest)
		case 'eth_getBalance': return await getBalance(simulator, parsedRequest)
		case 'eth_estimateGas': return await estimateGas(simulator, parsedRequest)
		case 'eth_getTransactionByHash': return await getTransactionByHash(simulator, parsedRequest)
		case 'eth_getTransactionReceipt': return await getTransactionReceipt(simulator, parsedRequest)
		case 'eth_sendTransaction': return sendTransaction(getActiveAddressForDomain, simulator, parsedRequest, socket, request, true, website, settings)
		case 'eth_call': return await call(simulator, parsedRequest)
		case 'eth_blockNumber': return await blockNumber(simulator)
		case 'eth_subscribe': return await subscribe(simulator, socket, parsedRequest)
		case 'eth_unsubscribe': return await unsubscribe(simulator, parsedRequest)
		case 'eth_chainId': return await chainId(simulator)
		case 'net_version': return await chainId(simulator)
		case 'eth_getCode': return await getCode(simulator, parsedRequest)
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(socket, parsedRequest, request, true, website, settings)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(socket, simulator, parsedRequest, request, true, website)
		case 'wallet_requestPermissions': return await requestPermissions(getActiveAddressForDomain, simulator, socket, settings)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(getActiveAddressForDomain, simulator, socket, settings)
		case 'eth_requestAccounts': return await getAccounts(getActiveAddressForDomain, simulator, socket, settings)
		case 'eth_gasPrice': return await gasPrice(simulator)
		case 'eth_getTransactionCount': return await getTransactionCount(simulator, parsedRequest)
		case 'interceptor_getSimulationStack': return await getSimulationStack(simulator, parsedRequest)
		case 'eth_multicall': return { error: { code: 10000, message: 'Cannot call eth_multicall directly' } }
		case 'eth_getStorageAt': return { error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		case 'eth_getLogs': return await getLogs(simulator, parsedRequest)
		case 'eth_sign': return { error: { code: 10000, message: 'eth_sign is deprecated' } }
		/*
		Missing methods:
		case 'eth_sendRawTransaction': return
		case 'eth_getProof': return
		case 'eth_getBlockTransactionCountByNumber': return
		case 'eth_getTransactionByBlockHashAndIndex': return
		case 'eth_getTransactionByBlockNumberAndIndex': return
		case 'eth_getBlockReceipts': return
		case 'eth_getStorageAt': return

		case 'eth_getLogs': return
		case 'eth_getFilterChanges': return
		case 'eth_getFilterLogs': return
		case 'eth_newBlockFilter': return
		case 'eth_newFilter': return
		case 'eth_newPendingTransactionFilter': return
		case 'eth_uninstallFilter': return

		case 'eth_protocolVersion': return
		case 'eth_feeHistory': return
		case 'eth_maxPriorityFeePerGas': return
		case 'net_listening': return

		case 'eth_getUncleByBlockHashAndIndex': return
		case 'eth_getUncleByBlockNumberAndIndex': return
		case 'eth_getUncleCountByBlockHash': return
		case 'eth_getUncleCountByBlockNumber': return
		*/
	}
}

async function handleSigningMode(simulator: Simulator, socket: WebsiteSocket, website: Website, request: InterceptedRequest, settings: Settings): Promise<HandleSimulationModeReturnValue> {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = EthereumJsonRpcRequest.parse(request.options)
	} catch (error) {
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	const forwardToSigner = () => ({ forward: true } as const)

	switch (parsedRequest.method) {
		case 'eth_getBlockByNumber':
		case 'eth_getBalance':
		case 'eth_estimateGas':
		case 'eth_getTransactionByHash':
		case 'eth_getTransactionReceipt':
		case 'eth_call':
		case 'eth_blockNumber':
		case 'eth_subscribe':
		case 'eth_unsubscribe':
		case 'eth_chainId':
		case 'net_version':
		case 'eth_getCode':
		case 'wallet_requestPermissions':
		case 'wallet_getPermissions':
		case 'eth_accounts':
		case 'eth_requestAccounts':
		case 'eth_gasPrice':
		case 'eth_getTransactionCount':
		case 'eth_multicall':
		case 'eth_getStorageAt':
		case 'eth_getLogs':
		case 'eth_sign':
		case 'interceptor_getSimulationStack': return forwardToSigner()

		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(socket, parsedRequest, request, false, website, settings)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(socket, simulator, parsedRequest, request, false, website)
		case 'eth_sendTransaction': {
			if (settings && isSupportedChain(settings.activeChain.toString()) ) {
				return sendTransaction(getActiveAddressForDomain, simulator, parsedRequest, socket, request, false, website, settings)
			}
			return forwardToSigner()
		}
		default: assertUnreachable(parsedRequest)
	}
}

function newBlockCallback(blockNumber: bigint) {
	sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { blockNumber } })
	if (simulator !== undefined) refreshSimulation(simulator)
}

export async function changeActiveAddressAndChainAndResetSimulation(activeAddress: bigint | undefined | 'noActiveAddressChange', activeChain: bigint | 'noActiveChainChange', settings: Settings) {
	if (simulator === undefined) return

	if (activeChain !== 'noActiveChainChange') {
		await setActiveChain(activeChain)
		const chainString = activeChain.toString()
		if (isSupportedChain(chainString)) {
			simulator.cleanup()
			simulator = new Simulator(chainString, newBlockCallback)
		}
	}

	if (activeAddress !== 'noActiveAddressChange') {
		if (settings.simulationMode) {
			await setActiveSimulationAddress(activeAddress)
		} else {
			await setActiveSigningAddress(activeAddress)
		}
	}
	const updatedSettings = await getSettings()
	updateWebsiteApprovalAccesses(undefined, updatedSettings)

	if (!await updatePrependMode(updatedSettings)) {// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		await updateSimulationState(async () => await simulator?.simulationModeNode.resetSimulation())
	}

	if (activeChain !== 'noActiveChainChange') {
		sendMessageToApprovedWebsitePorts('chainChanged', EthereumQuantity.serialize(activeChain))
		sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
	}

	// inform all the tabs about the address change (this needs to be done on only chain changes too)
	sendActiveAccountChangeToApprovedWebsitePorts(updatedSettings)
	if (activeAddress !== 'noActiveAddressChange') {
		sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	}
}

export async function changeActiveChain(chainId: bigint) {
	const settings = await getSettings()
	if (settings.simulationMode) {
		return await changeActiveAddressAndChainAndResetSimulation('noActiveAddressChange', chainId, settings)
	}
	sendMessageToApprovedWebsitePorts('request_signer_to_wallet_switchEthereumChain', EthereumQuantity.serialize(chainId))
}

type ProviderHandler = (port: browser.runtime.Port, request: ProviderMessage, settings: Settings) => Promise<unknown>
const providerHandlers = new Map<string, ProviderHandler >([
	['eth_accounts_reply', ethAccountsReply],
	['signer_chainChanged', signerChainChanged],
	['wallet_switchEthereumChain_reply', walletSwitchEthereumChainReply],
	['connected_to_signer', connectedToSigner]
])
export function postMessageIfStillConnected(socket: WebsiteSocket, message: InterceptedRequestForward) {
	const tabConnection = globalThis.interceptor.websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const [socketAsString, connection] of Object.entries(tabConnection.connections)) {
		if (socketAsString !== identifier) continue
		try {
			connection.port.postMessage(message)
		} catch (error) {
			if (error instanceof Error) {
				if (error.message?.includes('Attempting to use a disconnected port object')) {
					return
				}
			}
			throw error
		}
	}
	return true
}

export function sendMessageToContentScript(socket: WebsiteSocket, resolved: HandleSimulationModeReturnValue, request: InterceptedRequest) {
	if ('error' in resolved) {
		return postMessageIfStillConnected(socket, {
			...resolved,
			interceptorApproved: false,
			requestId: request.requestId,
			options: request.options
		})
	}
	if (!('forward' in resolved)) {
		return postMessageIfStillConnected(socket, {
			result: resolved.result,
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options
		})
	}

	return postMessageIfStillConnected(socket, {
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options
	})
}

export async function handleContentScriptMessage(socket: WebsiteSocket, request: InterceptedRequest, website: Website) {
	try {
		if (simulator === undefined) throw 'Interceptor not ready'
		const settings = await getSettings()
		const resolved = settings.simulationMode || request.usingInterceptorWithoutSigner ?
			await handleSimulationMode(simulator, socket, website, request, settings)
			: await handleSigningMode(simulator, socket, website, request, settings)
		return sendMessageToContentScript(socket, resolved, request)
	} catch(error) {
		postMessageIfStillConnected(socket, {
			interceptorApproved: false,
			requestId: request.requestId,
			options: request.options,
			error: {
				code: 123456,
				message: 'Unknown error'
			}
		})
		throw error
	}
}

export function refuseAccess(socket: WebsiteSocket, request: InterceptedRequest) {
	return postMessageIfStillConnected(socket, {
		interceptorApproved: false,
		requestId: request.requestId,
		options: request.options,
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'User refused access to the wallet'
		}
	})
}

export async function gateKeepRequestBehindAccessDialog(socket: WebsiteSocket, request: InterceptedRequest, website: Website, settings: Settings) {
	const activeAddress = getActiveAddress(settings)
	const addressInfo = activeAddress !== undefined ? findAddressInfo(activeAddress, settings.userAddressBook.addressInfos) : undefined
	return await requestAccessFromUser(socket, website, request, addressInfo, getAssociatedAddresses(settings, website.websiteOrigin, addressInfo), settings)
}

async function onContentScriptConnected(port: browser.runtime.Port) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const websitePromise = retrieveWebsiteDetails(port, websiteOrigin)
	const identifier = websiteSocketToString(socket)

	console.log(`content script connected ${ websiteOrigin }`)

	const tabConnection = globalThis.interceptor.websiteTabConnections.get(socket.tabId)
	const newConnection = {
		port: port,
		socket: socket,
		websiteOrigin: websiteOrigin,
		approved: false,
		wantsToConnect: false,
	}
	port.onDisconnect.addListener(() => {
		const tabConnection = globalThis.interceptor.websiteTabConnections.get(socket.tabId)
		if (tabConnection === undefined) return
		delete tabConnection.connections[websiteSocketToString(socket)]
		if (Object.keys(tabConnection).length === 0) {
			globalThis.interceptor.websiteTabConnections.delete(socket.tabId)
		}
	})
	port.onMessage.addListener(async (payload) => {
		if(!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		const request = InterceptedRequest.parse(payload.data)
		const providerHandler = providerHandlers.get(request.options.method)
		const settings = await getSettings()
		if (providerHandler) {
			await providerHandler(port, request, settings)
			return sendMessageToContentScript(socket, { 'result': '0x' }, request)
		}

		const access = verifyAccess(socket, request.options.method, websiteOrigin, settings)

		if (access === 'askAccess' && request.options.method === 'eth_accounts') {
			// do not prompt for eth_accounts, just reply with no accounts.
			return sendMessageToContentScript(socket, { 'result': [] }, request)
		}

		switch (access) {
			case 'noAccess': return refuseAccess(socket, request)
			case 'askAccess': return await gateKeepRequestBehindAccessDialog(socket, request, await websitePromise, settings)
			case 'hasAccess': return await handleContentScriptMessage(socket, request, await websitePromise)
			default: assertNever(access)
		}
	})

	if (tabConnection === undefined) {
		globalThis.interceptor.websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, async (previousState: TabState) => {
			return {
				...previousState,
				tabIconDetails: {
					icon: ICON_NOT_ACTIVE,
					iconReason: 'No active address selected.',
				}
			}
		})
		updateExtensionIcon(socket, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}

}

async function popupMessageHandler(simulator: Simulator, request: unknown, settings: Settings) {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = PopupMessage.parse(request)
	} catch (error) {
		console.log(request)
		console.log(error)
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	switch (parsedRequest.method) {
		case 'popup_confirmDialog': return await confirmDialog(simulator, parsedRequest)
		case 'popup_changeActiveAddress': return await changeActiveAddress(simulator, parsedRequest)
		case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator, parsedRequest, settings)
		case 'popup_changePage': return await changePage(simulator, parsedRequest)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(simulator, parsedRequest)
		case 'popup_resetSimulation': return await resetSimulation(simulator)
		case 'popup_removeTransaction': return await removeTransaction(simulator, parsedRequest)
		case 'popup_refreshSimulation': return await refreshSimulation(simulator)
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator, parsedRequest)
		case 'popup_personalSign': return await confirmPersonalSign(simulator, parsedRequest)
		case 'popup_interceptorAccess': return await confirmRequestAccess(simulator, parsedRequest)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(simulator, parsedRequest, settings)
		case 'popup_changeActiveChain': return await popupChangeActiveChain(simulator, parsedRequest)
		case 'popup_changeChainDialog': return await changeChainDialog(simulator, parsedRequest)
		case 'popup_enableSimulationMode': return await enableSimulationMode(simulator, parsedRequest, settings)
		case 'popup_reviewNotification': return await reviewNotification(simulator, parsedRequest, settings)
		case 'popup_rejectNotification': return await rejectNotification(simulator, parsedRequest)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressInfo(simulator, parsedRequest)
		case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest, settings.userAddressBook)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(simulator, parsedRequest)
		case 'popup_openAddressBook': return await openAddressBook(simulator)
		case 'popup_personalSignReadyAndListening': return // handled elsewhere (personalSign.ts)
		case 'popup_changeChainReadyAndListening': return // handled elsewhere (changeChain.ts)
		case 'popup_interceptorAccessReadyAndListening': return // handled elsewhere (interceptorAccess.ts)
		case 'popup_confirmTransactionReadyAndListening': return // handled elsewhere (confirmTransaction.ts)
		case 'popup_requestNewHomeData': return homeOpened(simulator)
		case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(parsedRequest)
		case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(parsedRequest)
		default: assertUnreachable(parsedRequest)
	}
}

async function startup() {
	const settings = await getSettings()
	await setExtensionIcon({ path: ICON_NOT_ACTIVE })
	await setExtensionBadgeBackgroundColor({ color: '#58a5b3' })

	const chainString = settings.activeChain.toString()
	if (isSupportedChain(chainString)) {
		simulator = new Simulator(chainString, newBlockCallback)
	} else {
		simulator = new Simulator('1', newBlockCallback) // initialize with mainnet, if user is not using any supported chains
	}
	if (settings.simulationMode) {
		changeActiveAddressAndChainAndResetSimulation(settings.activeSimulationAddress, settings.activeChain, settings)
	}

	browser.runtime.onMessage.addListener(async function(message: unknown) {
		if (simulator === undefined) throw new Error('Interceptor not ready yet')
		await popupMessageHandler(simulator, message, await getSettings())
	})
	await updateExtensionBadge()
}

startup()
