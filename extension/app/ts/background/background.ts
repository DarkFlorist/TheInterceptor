import { InterceptedRequest, InterceptedRequestForward, PopupMessage, ProviderMessage, SignerName } from '../utils/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { EIP2612Message, EthereumQuantity, EthereumUnsignedTransaction } from '../utils/wire-types.js'
import { getSettings, saveActiveChain, saveActiveSigningAddress, saveActiveSimulationAddress, Settings } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, personalSign, requestPermissions, sendRawTransaction, sendTransaction, signTypedDataV4, subscribe, switchEthereumChain, unsubscribe } from './simulationModeHanders.js'
import { changeActiveAddress, changeAddressInfos, changeMakeMeRich, changePage, resetSimulation, confirmDialog, RefreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveChain, enableSimulationMode, reviewNotification, rejectNotification, addOrModifyAddressInfo, getAddressBookData } from './popupMessageHandlers.js'
import { AddressMetadata, SimResults, SimulationState, TokenPriceEstimate } from '../utils/visualizer-types.js'
import { WebsiteApproval, SignerState, TabConnection } from '../utils/user-interface-types.js'
import { getAddressMetadataForAccess, setPendingAccessRequests } from './windows/interceptorAccess.js'
import { CHAINS, ICON_NOT_ACTIVE, isSupportedChain, MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { getActiveAddressForDomain, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { getAddressMetadataForVisualiser } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updateExtensionIcon } from './iconHandler.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'

browser.runtime.onConnect.addListener(port => onContentScriptConnected(port).catch(console.error))

export enum PrependTransactionMode {
	NO_PREPEND,
	RICH_MODE
}

let currentPrependMode: PrependTransactionMode = PrependTransactionMode.NO_PREPEND
let simulator: Simulator | undefined = undefined

declare global {
	interface Window {
		interceptor: {
			confirmTransactionDialog?: {
				requestToConfirm: InterceptedRequest,
				transactionToSimulate: unknown,
				simulationMode: boolean,
				simulationState: SimulationState | undefined,
				isComputingSimulation: boolean,
				visualizerResults: SimResults[] | undefined,
				addressMetadata: [string, AddressMetadata][],
				tokenPrices: TokenPriceEstimate[],
				activeAddress: bigint,
			}
			personalSignDialog?: {
				requestToConfirm: InterceptedRequest,
				simulationMode: boolean,
				message: string,
				account: string,
				method: 'personalSign' | 'v4',
				addressMetadata: [string, AddressMetadata][],
				eip2612Message?: EIP2612Message,
			}
			interceptorAccessDialog?: {
				origin: string,
				icon: string | undefined,
				requestAccessToAddress: string | undefined,
				addressMetadata: [string, AddressMetadata][],
			}
			changeChainDialog?: {
				requestToConfirm: InterceptedRequest,
				chainId: string,
				origin: string,
				icon: string | undefined,
				simulationMode: boolean,
			}
			simulation: {
				simulationId: number,
				simulationState: SimulationState | undefined,
				isComputingSimulation: boolean,
				visualizerResults: SimResults[] | undefined,
				addressMetadata: [string, AddressMetadata][],
				tokenPrices: TokenPriceEstimate[],
			}
			websiteAccessAddressMetadata: [string, AddressMetadata][],
			pendingAccessMetadata: [string, AddressMetadata][],
			prependTransactionMode: PrependTransactionMode,
			signerAccounts: readonly bigint[] | undefined,
			signerChain: bigint | undefined,
			signerName: SignerName | undefined,
			websiteTabSignerStates: Map<number, SignerState>,
			websitePortApprovals: Map<browser.runtime.Port, WebsiteApproval>, // map of ports that are either approved or not-approved by interceptor
			websiteTabApprovals: Map<number, WebsiteApproval>,
			websiteTabConnection: Map<number, TabConnection>,
			settings: Settings | undefined,
			currentBlockNumber: bigint | undefined,
		}
	}
}

window.interceptor = {
	prependTransactionMode: PrependTransactionMode.NO_PREPEND,
	websiteAccessAddressMetadata: [],
	pendingAccessMetadata: [],
	signerAccounts: undefined,
	signerChain: undefined,
	signerName: undefined,
	websiteTabSignerStates: new Map(),
	settings: undefined,
	websitePortApprovals: new Map(),
	websiteTabApprovals: new Map(),
	websiteTabConnection: new Map(),
	simulation: {
		simulationId: 0,
		simulationState: undefined,
		isComputingSimulation: false,
		visualizerResults: undefined,
		addressMetadata: [],
		tokenPrices: [],
	},
	currentBlockNumber: undefined,
}

export async function updateSimulationState( getUpdatedSimulationState: () => Promise<SimulationState | undefined>) {
	try {
		window.interceptor.simulation.isComputingSimulation = true
		sendPopupMessageToOpenWindows({ message: 'popup_started_simulation_update' })
		window.interceptor.simulation.simulationId++

		if ( simulator === undefined ) {
			window.interceptor.simulation = {
				simulationId: window.interceptor.simulation.simulationId,
				simulationState: undefined,
				isComputingSimulation: false,
				addressMetadata: [],
				tokenPrices: [],
				visualizerResults: [],
			}
			sendPopupMessageToOpenWindows({ message: 'popup_simulation_state_changed' })
			return
		}

		const updatedSimulationState = await getUpdatedSimulationState()

		const simId = window.interceptor.simulation.simulationId
		if ( updatedSimulationState !== undefined ) {
			const priceEstimator = new PriceEstimator(simulator.ethereum)

			const transactions = updatedSimulationState.simulatedTransactions.map(x => x.unsignedTransaction)
			const visualizerResult = await simulator.visualizeTransactionChain(transactions, updatedSimulationState.blockNumber, updatedSimulationState.simulatedTransactions.map( x => x.multicallResponse))
			const addressMetadata = await getAddressMetadataForVisualiser(simulator, visualizerResult.map( (x) => x.visualizerResults), updatedSimulationState, window.interceptor.settings?.addressInfos)

			function onlyTokensAndTokensWithKnownDecimals(metadata: [string, AddressMetadata]) : metadata is [string, AddressMetadata & { metadataSource: 'token', decimals: `0x${ string }` } ]  {
				if (metadata[1].metadataSource !== 'token') return false
				if (metadata[1].decimals === undefined) return false
				return true
			}
			function metadataRestructure([address, metadata]: [string, AddressMetadata & { metadataSource: 'token', decimals: bigint } ] ) {
				return { token: BigInt(address), decimals: BigInt(metadata.decimals) }
			}
			const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(addressMetadata.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))

			if (simId !== window.interceptor.simulation.simulationId) return // do not update state if we are already calculating a new one

			window.interceptor.simulation = {
				simulationId: window.interceptor.simulation.simulationId,
				tokenPrices: tokenPrices,
				addressMetadata: addressMetadata,
				visualizerResults: visualizerResult,
				simulationState: updatedSimulationState,
				isComputingSimulation: false,
			}
		} else {
			window.interceptor.simulation = {
				simulationId: window.interceptor.simulation.simulationId,
				addressMetadata: [],
				tokenPrices: [],
				visualizerResults: [],
				simulationState: updatedSimulationState,
				isComputingSimulation: false,
			}
		}
		sendPopupMessageToOpenWindows({ message: 'popup_simulation_state_changed' })
		return updatedSimulationState
	} catch(e) {
		throw e
	} finally {
		window.interceptor.simulation.isComputingSimulation = false
	}
}

export function setEthereumNodeBlockPolling(enabled: boolean) {
	if (simulator === undefined) return
	simulator.ethereum.setBlockPolling(enabled)
}

export async function refreshConfirmTransactionSimulation() {
	if ( window.interceptor.confirmTransactionDialog === undefined ) return
	if ( simulator === undefined ) return
	const priceEstimator = new PriceEstimator(simulator.ethereum)
	const newSimulator = simulator.simulationModeNode.copy()
	const currentRequestId = window.interceptor.confirmTransactionDialog.requestToConfirm.requestId
	window.interceptor.confirmTransactionDialog.isComputingSimulation = true
	sendPopupMessageToOpenWindows({ message: 'popup_confirm_transaction_simulation_started' })
	const appended = await newSimulator.appendTransaction(EthereumUnsignedTransaction.parse(window.interceptor.confirmTransactionDialog.transactionToSimulate))
	const transactions = appended.simulationState.simulatedTransactions.map(x => x.unsignedTransaction)
	const visualizerResult = await simulator.visualizeTransactionChain(transactions, appended.simulationState.blockNumber, appended.simulationState.simulatedTransactions.map( x => x.multicallResponse))
	const addressMetadata = await getAddressMetadataForVisualiser(simulator, visualizerResult.map( (x) => x.visualizerResults), appended.simulationState, window.interceptor.settings?.addressInfos)
	const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(
		addressMetadata.map(
			(x) => x[1].metadataSource === 'token' && x[1].decimals !== undefined ? { token: BigInt(x[0]), decimals: x[1].decimals } : { token: 0x0n, decimals: 0x0n }
		).filter( (x) => x.token !== 0x0n )
	)

	if ( window.interceptor.confirmTransactionDialog === undefined || window.interceptor.confirmTransactionDialog.requestToConfirm.requestId !== currentRequestId ) return // fixes race condition where user has already closed the dialog or initiated a new one

	window.interceptor.confirmTransactionDialog.tokenPrices = tokenPrices
	window.interceptor.confirmTransactionDialog.simulationState = appended.simulationState
	window.interceptor.confirmTransactionDialog.addressMetadata = addressMetadata
	window.interceptor.confirmTransactionDialog.visualizerResults = visualizerResult
	window.interceptor.confirmTransactionDialog.isComputingSimulation = false
	sendPopupMessageToOpenWindows({ message: 'popup_confirm_transaction_simulation_state_changed' })
}

// returns true if simulation state was changed
export async function updatePrependMode(forceRefresh: boolean = false) {
	if ( currentPrependMode === window.interceptor.prependTransactionMode && !forceRefresh ) return
	if ( simulator === undefined ) return
	if ( window.interceptor.settings === undefined ) return
	if ( !window.interceptor.settings.simulationMode ) {
		await updateSimulationState(async () => await simulator?.simulationModeNode.setPrependTransactionsQueue([]))
		currentPrependMode = window.interceptor.prependTransactionMode
		return true
	}

	switch(window.interceptor.prependTransactionMode) {
		case PrependTransactionMode.NO_PREPEND: {
			await updateSimulationState(async () => await simulator?.simulationModeNode.setPrependTransactionsQueue([]))
			break
		}
		case PrependTransactionMode.RICH_MODE: {
			const activeAddress = getActiveAddress()
			const chainId = window.interceptor.settings.activeChain.toString()
			if ( !isSupportedChain(chainId) ) return false
			if ( activeAddress === undefined ) return false
			await updateSimulationState(async () => {
				if ( window.interceptor.settings === undefined ) return undefined
				if ( simulator === undefined ) return undefined
				if ( !isSupportedChain(chainId) ) return undefined
				const queue = [{
					from: CHAINS[chainId].eth_donator,
					chainId: CHAINS[chainId].chainId,
					nonce: await simulator.ethereum.getTransactionCount(CHAINS[chainId].eth_donator),
					to: activeAddress,
					...MAKE_YOU_RICH_TRANSACTION
				} as const]
				return await simulator.simulationModeNode.setPrependTransactionsQueue(queue)
			})
			break
		}
	}
	currentPrependMode = window.interceptor.prependTransactionMode
	return true
}

export async function appendTransactionToSimulator(transaction: EthereumUnsignedTransaction) {
	if ( simulator === undefined) return
	const simulationState = await updateSimulationState(async () => (await simulator?.simulationModeNode.appendTransaction(transaction))?.simulationState)
	return {
		signed: await simulator.simulationModeNode.mockSignTransaction(transaction),
		simulationState: simulationState,
	}
}

export async function personalSignWithSimulator(message: string, account: bigint) {
	if ( simulator === undefined) return
	return await simulator.simulationModeNode.personalSign(message, account)
}

type SimulationHandler = (simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) => Promise<void>

export const handlers = new Map<string, SimulationHandler >([
	['eth_getBlockByNumber', getBlockByNumber],
	['eth_getBalance', getBalance],
	['eth_estimateGas', estimateGas],
	['eth_getTransactionByHash', getTransactionByHash],
	['eth_getTransactionReceipt', getTransactionReceipt],
	['eth_sendTransaction', sendTransaction],
	['eth_call', call],
	['eth_blockNumber', blockNumber],
	['eth_subscribe', subscribe],
	['eth_unsubscribe', unsubscribe],
	['eth_chainId', chainId],
	['net_version', chainId],
	['eth_getCode', getCode],
	['personal_sign', personalSign],
	['eth_signTypedData_v4', signTypedDataV4],
	['wallet_switchEthereumChain', switchEthereumChain ],
	['wallet_requestPermissions', requestPermissions.bind(undefined, getActiveAddressForDomain) ],
	['wallet_getPermissions', getPermissions ],
	['eth_accounts', getAccounts.bind(undefined, getActiveAddressForDomain)],
	['eth_requestAccounts', getAccounts.bind(undefined, getActiveAddressForDomain)],
	['eth_sendRawTransaction', sendRawTransaction],
	['eth_gasPrice', gasPrice],
	['eth_getTransactionCount', getTransactionCount],
	['interceptor_getSimulationStack', getSimulationStack],

	/*
	Missing methods:
	['eth_getProof', ],
	['eth_getBlockTransactionCountByNumber', ],
	['eth_getTransactionByBlockHashAndIndex', ],
	['eth_getTransactionByBlockNumberAndIndex', ],
	['eth_getBlockReceipts', ]
	['eth_getStorageAt', ],

	['eth_getLogs', ],
	['eth_getFilterChanges', ],
	['eth_getFilterLogs', ],
	['eth_newBlockFilter', ],
	['eth_newFilter', ],
	['eth_newPendingTransactionFilter', ],
	['eth_uninstallFilter', ],

	['eth_protocolVersion', ],
	['eth_feeHistory', ],
	['eth_maxPriorityFeePerGas', ],
	['net_listening', ],

	['eth_getUncleByBlockHashAndIndex', ],
	['eth_getUncleByBlockNumberAndIndex', ],
	['eth_getUncleCountByBlockHash', ],
	['eth_getUncleCountByBlockNumber', ],
	*/
])

async function handleSimulationMode(port: browser.runtime.Port, request: InterceptedRequest) {
	if ( simulator === undefined ) return
	await updatePrependMode()
	const handler = handlers.get(request.options.method)
	if (handler === undefined) {
		if ( request.usingInterceptorWithoutSigner || window.interceptor.settings?.simulationMode ) return
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options
		})
	}
	return await handler(simulator, port, request)
}

function newBlockCallback(blockNumber: bigint) {
	window.interceptor.currentBlockNumber = blockNumber
	sendPopupMessageToOpenWindows({ message: 'popup_new_block_arrived' })
}

export async function changeActiveAddressAndChainAndResetSimulation(activeAddress: bigint | undefined | 'noActiveAddressChange', activeChain: bigint | 'noActiveChainChange') {
	if (window.interceptor.settings === undefined) return
	if ( simulator === undefined ) return

	let chainChanged = false
	if ( await simulator.ethereum.getChainId() !== activeChain && activeChain !== 'noActiveChainChange') {

		window.interceptor.settings.activeChain = activeChain
		saveActiveChain(activeChain)
		const chainString = activeChain.toString()
		if (isSupportedChain(chainString)) {
			const isPolling = simulator.ethereum.isBlockPolling()
			window.interceptor.currentBlockNumber = undefined
			simulator.cleanup()
			simulator = new Simulator(chainString, isPolling, newBlockCallback)
		}

		// inform all the tabs about the chain change
		chainChanged = true
	}

	if (activeAddress !== 'noActiveAddressChange') {
		if (window.interceptor.settings.simulationMode) {
			window.interceptor.settings.activeSimulationAddress = activeAddress
			saveActiveSimulationAddress(activeAddress)
		} else {
			window.interceptor.settings.activeSigningAddress = activeAddress
			saveActiveSigningAddress(activeAddress)
		}
	}
	updateWebsiteApprovalAccesses()

	if (!await updatePrependMode(true)) {// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		await updateSimulationState(async () => await simulator?.simulationModeNode.resetSimulation())
	}

	if (chainChanged) {
		sendMessageToApprovedWebsitePorts('chainChanged', EthereumQuantity.serialize(window.interceptor.settings.activeChain))
		sendPopupMessageToOpenWindows({ message: 'popup_chain_update' })
	}

	// inform all the tabs about the address change (this needs to be done on only chain changes too)
	sendActiveAccountChangeToApprovedWebsitePorts()
	if (activeAddress !== 'noActiveAddressChange') {
		sendPopupMessageToOpenWindows({ message: 'popup_accounts_update' })
	}
}


export async function changeActiveChain(chainId: bigint) {
	if (window.interceptor.settings === undefined) return
	if (window.interceptor.settings.simulationMode) {
		return await changeActiveAddressAndChainAndResetSimulation('noActiveAddressChange', chainId)
	} else {
		sendMessageToApprovedWebsitePorts('request_signer_to_wallet_switchEthereumChain', EthereumQuantity.serialize(chainId))
	}
}

type ProviderHandler = (port: browser.runtime.Port, request: ProviderMessage) => void
const providerHandlers = new Map<string, ProviderHandler >([
	['eth_accounts_reply', ethAccountsReply],
	['signer_chainChanged', signerChainChanged],
	['wallet_switchEthereumChain_reply', walletSwitchEthereumChainReply],
	['connected_to_signer', connectedToSigner]
])

export function postMessageIfStillConnected(port: browser.runtime.Port, message: InterceptedRequestForward) {
	const tabId = port.sender?.tab?.id
	if ( tabId === undefined ) return
	if (!window.interceptor.websiteTabConnection.has(tabId)) return
	port.postMessage(message)
}

async function onContentScriptConnected(port: browser.runtime.Port) {
	console.log('content script connected')
	let connectionStatus: 'connected' | 'disconnected' | 'notInitialized' = 'notInitialized'
	port.onDisconnect.addListener(() => {
		connectionStatus = 'disconnected'
		const tabId = port.sender?.tab?.id
		if ( tabId === undefined ) return
		window.interceptor.websiteTabConnection.delete(tabId)
	})
	port.onMessage.addListener(async (payload) => {
		if (connectionStatus === 'disconnected') return

		if(!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		// received message from injected.ts page
		const request = InterceptedRequest.parse(payload.data)
		console.log(request.options.method)

		const tabId = port.sender?.tab?.id
		if ( tabId === undefined ) return

		if (!window.interceptor.websiteTabConnection.has(tabId)) {
			updateExtensionIcon(port)
		}

		try {
			const providerHandler = providerHandlers.get(request.options.method)
			if (providerHandler) {
				return providerHandler(port, request)
			}

			if (!(await verifyAccess(port, request.options.method))) {
				return postMessageIfStillConnected(port, {
					interceptorApproved: false,
					requestId: request.requestId,
					options: request.options,
					error: {
						code: METAMASK_ERROR_USER_REJECTED_REQUEST,
						message: 'User refused access to the wallet'
					}
				})
			}
			if (connectionStatus === 'notInitialized' && window.interceptor.settings?.activeChain !== undefined) {
				console.log('send connect!')
				postMessageIfStillConnected(port, {
					interceptorApproved: true,
					options: { method: 'connect' },
					result: [EthereumQuantity.serialize(window.interceptor.settings.activeChain)]
				})
				connectionStatus = 'connected'
			}
			if (!window.interceptor.settings?.simulationMode || window.interceptor.settings?.useSignersAddressAsActiveAddress) {
				// request info (chain and accounts) from the connection right away after the user has approved connection
				if (port.sender?.tab?.id !== undefined) {
					if ( window.interceptor.websiteTabSignerStates.get(port.sender.tab.id) === undefined) {
						postMessageIfStillConnected(port, {
							interceptorApproved: true,
							options: { method: 'request_signer_to_eth_requestAccounts' },
							result: []
						})
						postMessageIfStillConnected(port, {
							interceptorApproved: true,
							options: { method: 'request_signer_chainId' },
							result: []
						})
					}
				}
			}
			if ( window.interceptor.settings?.simulationMode || request.usingInterceptorWithoutSigner) {
				return await handleSimulationMode(port, request)
			}

			// if simulation mode is not on, we only intercept eth_sendTransaction and personalSign
			if ( simulator === undefined ) throw 'Interceptor not ready'

			if (request.options.method === 'personal_sign') return personalSign(simulator, port, request, false)
			if (request.options.method === 'wallet_switchEthereumChain') return switchEthereumChain(simulator, port, request)

			if ( window.interceptor.settings && isSupportedChain(window.interceptor.settings.activeChain.toString()) )  {
				// we only support this method if we are on supported chain, otherwise forward to signer directly
				if (request.options.method === 'eth_sendTransaction') return sendTransaction(simulator, port, request, false)
			}

			return postMessageIfStillConnected(port, {
				interceptorApproved: true,
				requestId: request.requestId,
				options: request.options
			})
		} catch(error) {
			postMessageIfStillConnected(port, {
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
	})
}

type PopupMessageHandler = (simulator: Simulator, request: PopupMessage) => Promise<void>

const popupMessageHandlers = new Map<string, PopupMessageHandler>([
	['popup_confirmDialog', confirmDialog],
	['popup_changeActiveAddress', changeActiveAddress],
	['popup_changeMakeMeRich', changeMakeMeRich],
	['popup_changeAddressInfos', changeAddressInfos],
	['popup_changePage', changePage],
	['popup_requestAccountsFromSigner', requestAccountsFromSigner],
	['popup_resetSimulation', resetSimulation],
	['popup_removeTransaction', removeTransaction],
	['popup_refreshSimulation', RefreshSimulation],
	['popup_refreshConfirmTransactionDialogSimulation', refreshPopupConfirmTransactionSimulation],
	['popup_personalSign', confirmPersonalSign],
	['popup_interceptorAccess', confirmRequestAccess],
	['popup_changeInterceptorAccess', changeInterceptorAccess],
	['popup_changeActiveChain', popupChangeActiveChain],
	['popup_changeChainDialog', changeChainDialog],
	['popup_enableSimulationMode', enableSimulationMode],
	['popup_reviewNotification', reviewNotification],
	['popup_rejectNotification', rejectNotification],
	['popup_addOrModifyAddressInfo', addOrModifyAddressInfo],
	['popup_getAddressBookData', getAddressBookData]
])

async function startup() {
	window.interceptor.settings = await getSettings()
	if (window.interceptor.settings.makeMeRich) {
		window.interceptor.prependTransactionMode = PrependTransactionMode.RICH_MODE
	} else {
		window.interceptor.prependTransactionMode = PrependTransactionMode.NO_PREPEND
	}

	browser.browserAction.setIcon( { path: ICON_NOT_ACTIVE } )
	browser.browserAction.setBadgeBackgroundColor( { color: '#58a5b3' } )

	// if we are using signers mode, update our active address representing to signers address
	if (window.interceptor.settings.useSignersAddressAsActiveAddress || window.interceptor.settings.simulationMode === false) {
		const signerAcc = (window.interceptor.signerAccounts && window.interceptor.signerAccounts.length > 0) ? window.interceptor.signerAccounts[0] : undefined
		if(window.interceptor.settings.simulationMode) {
			window.interceptor.settings.activeSimulationAddress = signerAcc
		} else {
			window.interceptor.settings.activeSigningAddress = signerAcc
		}
	}

	window.interceptor.websiteAccessAddressMetadata = getAddressMetadataForAccess(window.interceptor.settings.websiteAccess)

	const chainString = window.interceptor.settings.activeChain.toString()
	if (isSupportedChain(chainString)) {
		simulator = new Simulator(chainString, false, newBlockCallback)
	} else {
		simulator = new Simulator('1', false, newBlockCallback) // initialize with mainnet, if user is not using any supported chains
	}
	if (window.interceptor.settings.simulationMode) {
		changeActiveAddressAndChainAndResetSimulation(window.interceptor.settings.activeSimulationAddress, window.interceptor.settings.activeChain)
	}

	browser.runtime.onMessage.addListener(async function(message: any) {
		console.log(message)
		try {
			const payload = PopupMessage.parse(message)
			const handler = popupMessageHandlers.get(payload.method)
			if (handler === undefined) throw `unknown popup message ${ payload.method }`
			if (simulator === undefined) return
			return await handler(simulator, message)
		}
		catch (error) {
			console.log('invalid popup message!')
			console.log(error)
		}
	})
	await setPendingAccessRequests(window.interceptor.settings.pendingAccessRequests)
}

startup()
