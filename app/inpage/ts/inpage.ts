const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902
const METAMASK_ERROR_BLANKET_ERROR = -32603
const METAMASK_METHOD_NOT_SUPPORTED = -32004
const METAMASK_INVALID_METHOD_PARAMS = -32602

interface IJsonRpcSuccess<TResult> {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly result: TResult
}
interface IJsonRpcError {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly error: {
		readonly code: number
		readonly message: string
		readonly data?: unknown
	}
}

class InterceptorFuture<T> implements PromiseLike<T> {
	private promise: Promise<T>
	private resolveFunction: (value: T | PromiseLike<T>) => void
	private rejectFunction: (reason: Error) => void

	constructor() {
		let resolveFunction: (value: T | PromiseLike<T>) => void
		let rejectFunction: (reason: Error) => void
		this.promise = new Promise((resolve: (value: T | PromiseLike<T>) => void, reject: (reason: Error) => void) => {
			resolveFunction = resolve
			rejectFunction = reject
		})
		// the function passed to the Promise constructor is called before the constructor returns, so we can be sure the resolve and reject functions have been set by here even if the compiler can't verify
		this.resolveFunction = resolveFunction!
		this.rejectFunction = rejectFunction!
	}

	public readonly then = <TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> => {
		return this.promise.then(onfulfilled, onrejected)
	}

	public readonly resolve = (value: T | PromiseLike<T>) => this.resolveFunction!(value)
	public readonly reject = (reason: Error) => this.rejectFunction!(reason)
}

type EthereumJsonRpcError = Error & {
	code: number
	data?: object
}

function EthereumJsonRpcError(code: number, message: string, data?: object): EthereumJsonRpcError {
	const error = new Error(message) as EthereumJsonRpcError
	error.name = 'EthereumJsonRpcError'
	error.code = code
	error.data = data
	return error
}

type MessageMethodAndParams = {
	readonly method: string,
	readonly params?: readonly unknown[]
}

type InterceptedRequestBase = {
	readonly interceptorApproved: true,
	readonly requestId?: number,
	readonly method: string,
	readonly params?: readonly unknown[]
	readonly subscription?: string
}

type InterceptedRequestForwardWithResult = InterceptedRequestBase & {
	readonly type: 'result',
	readonly result: unknown,
}

type InterceptedRequestForwardWithError = InterceptedRequestBase & {
	readonly type: 'result',
	readonly error: {
		readonly code: number,
		readonly message: string,
		readonly data?: object
	}
}

type InterceptedRequestForwardToSigner = InterceptedRequestBase & { readonly type: 'forwardToSigner', readonly replyWithSignersReply?: true }

type InterceptedRequestForward = InterceptedRequestForwardWithResult | InterceptedRequestForwardWithError | InterceptedRequestForwardToSigner

interface ProviderConnectInfo {
	readonly chainId: string
}

interface ProviderRpcError extends Error {
	message: string
	code: number
	data?: unknown
}

interface ProviderMessage {
	readonly type: string
	readonly data: unknown
}

type AnyCallBack =  ((message: ProviderMessage) => void)
	| ((connectInfo: ProviderConnectInfo) => void)
	| ((accounts: readonly string[]) => void)
	| ((error: ProviderRpcError) => void)
	| ((chainId: string) => void)

type EthereumRequest = (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }) => Promise<unknown>

type InjectFunctions = {
	request: EthereumRequest
	send: unknown
	sendAsync: unknown
	on: (kind: OnMessage, callback: AnyCallBack) => WindowEthereum
	removeListener: (kind: OnMessage, callback: AnyCallBack) => WindowEthereum
	isConnected?: () => boolean
	enable: () => void
}

type UnsupportedWindowEthereumMethods = {
	// We don't support these
	once?: () => void
	prependListener?: () => void
	prependOnceListener?: () => void
	_metamask?: {
		isUnlocked: () => Promise<boolean>
		requestBatch: () => Promise<void>,
	}
}

type WindowEthereum = InjectFunctions & {
	isBraveWallet?: boolean,
	isMetaMask?: boolean,
	isInterceptor?: boolean,
	providerMap?: Map<string, WindowEthereum>, // coinbase does not inject `isCoinbaseWallet` to the window.ethereum if there's already other wallets present (eg, Interceptor or Metamask), but instead injects a provider map that contains all these providers
	isCoinbaseWallet?: boolean,

	// for metamask compatibility mode
	selectedAddress?: string | null,
	chainId?: string,
	networkVersion?: string,
}

type InpageWindow = Window & {
	ethereum?: WindowEthereum
	web3?: {
		currentProvider: WindowEthereum
		accounts: readonly string[]
	}
}

const inpageWindow: InpageWindow = window

interface EIP6963ProviderInfo {
	uuid: string
	name: string
	icon: string
	rdns: string
}

type SingleSendAsyncParam = { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] }

type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'
type Signer = 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave' | 'CoinbaseWallet'

interface InterceptorMessageListener {
	readonly onMessage: (messageEvent: unknown) => Promise<void>
	readonly injectEthereumIntoWindow: () => void
}

function isStringArray(arr: unknown[]): arr is string[] {
	return arr.every((item) => typeof item === 'string')
}

function getErrorCodeAndMessage(error: unknown): error is { code: number, message: string } {
	if (typeof error !== 'object' || error === null) return false
	if (!('code' in error) || !('message' in error)) return false
	return typeof error.code === 'number' && typeof error.message === 'string'
}

function exhaustivenessCheck(_thing: never) {}

function InterceptorMessageListener(): InterceptorMessageListener {
	let connected = false
	let requestId = 0
	let metamaskCompatibilityMode = false
	let signerWindowEthereumRequest: EthereumRequest | undefined = undefined
	const outstandingRequests = new Map<number, InterceptorFuture<unknown>>()
	const onMessageCallBacks = new Set<((message: ProviderMessage) => void)>()
	const onConnectCallBacks = new Set<((connectInfo: ProviderConnectInfo) => void)>()
	const onAccountsChangedCallBacks = new Set<((accounts: readonly string[]) => void)>()
	const onDisconnectCallBacks = new Set<((error: ProviderRpcError) => void)>()
	const onChainChangedCallBacks = new Set<((chainId: string) => void)>()
	let currentAddress = ''
	let activeChainId = ''
	let currentSigner: Signer = 'NoSigner'
	let signerAccounts: string[] = []
	let pendingSignerAddressRequest: InterceptorFuture<boolean> | undefined = undefined

	const WindowEthereumIsConnected = () => connected

	const sendMessageToBackgroundPage = async (messageMethodAndParams: MessageMethodAndParams) => {
		requestId += 1
		const pendingRequestId = requestId
		const future = new InterceptorFuture<unknown>()
		outstandingRequests.set(pendingRequestId, future)
		try {
			window.postMessage({
				interceptorRequest: true,
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
				usingInterceptorWithoutSigner: signerWindowEthereumRequest === undefined,
				requestId: pendingRequestId,
			}, '*')
			return await future
		} finally {
			outstandingRequests.delete(pendingRequestId)
		}
	}

	const WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }) => {
		try {
			return await sendMessageToBackgroundPage({
				method: methodAndParams.method,
				...(methodAndParams.params !== undefined ? { params: methodAndParams.params } : {}),
			})
		} catch (error: unknown) {
			if (error instanceof Error) throw error
			throw EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { error, request: methodAndParams })
		}
	}

	const WindowEthereumSend = (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] } | string, maybeCallBack: undefined | ((error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void)) => {
		const fullPayload = typeof payload === 'string' ? { method: payload, id: 1, params: [] } : payload
		if (maybeCallBack !== undefined && typeof maybeCallBack === 'function') return WindowEthereumSendAsync(fullPayload, maybeCallBack)
		if (metamaskCompatibilityMode) {
			if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is missing')
			switch (fullPayload.method) {
				case 'eth_coinbase':
				case 'eth_accounts': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.selectedAddress === undefined || inpageWindow.ethereum.selectedAddress === null ? [] : [inpageWindow.ethereum.selectedAddress] }
				case 'net_version': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.networkVersion }
				case 'eth_chainId': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.chainId }
				default: throw EthereumJsonRpcError(METAMASK_INVALID_METHOD_PARAMS, `Invalid method parameter for window.ethereum.send: ${ fullPayload.method }`)
			}
		}
		throw EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, 'Method not supported (window.ethereum.send).')
	}

	const WindowEthereumSendAsync = async (payload: SingleSendAsyncParam | SingleSendAsyncParam[], callback: (error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void) => {
		const payloadArray = Array.isArray(payload) ? payload : [payload]
		payloadArray.map((param) => WindowEthereumRequest(param)
			.then((result) => callback(null, { jsonrpc: '2.0', id: param.id, result }))
			.catch((error) => {
				if (getErrorCodeAndMessage(error)) {
					const data = 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data : {}
					const stack = 'stack' in error && typeof error.stack === 'string' ? { stack: error.stack } : {}
					return callback({
						jsonrpc: '2.0',
						id: param.id,
						error: {
							code: error.code,
							message: error.message,
							data: { ...data, ...stack },
						},
					}, null)
				}
				return callback({
					jsonrpc: '2.0',
					id: param.id,
					error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR },
				}, null)
			}),
		)
	}

	const WindowEthereumOn = (kind: OnMessage, callback: AnyCallBack) => {
		if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
		switch (kind) {
			case 'accountsChanged':
				onAccountsChangedCallBacks.add(callback as (accounts: readonly string[]) => void)
				break
			case 'message':
				onMessageCallBacks.add(callback as (message: ProviderMessage) => void)
				break
			case 'connect':
				onConnectCallBacks.add(callback as (connectInfo: ProviderConnectInfo) => void)
				break
			case 'close':
			case 'disconnect':
				onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				break
			case 'chainChanged':
				onChainChangedCallBacks.add(callback as (chainId: string) => void)
				break
			default:
				exhaustivenessCheck(kind)
		}
		return inpageWindow.ethereum
	}

	const WindowEthereumRemoveListener = (kind: OnMessage, callback: AnyCallBack) => {
		if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
		switch (kind) {
			case 'accountsChanged':
				onAccountsChangedCallBacks.delete(callback as (accounts: readonly string[]) => void)
				break
			case 'message':
				onMessageCallBacks.delete(callback as (message: ProviderMessage) => void)
				break
			case 'connect':
				onConnectCallBacks.delete(callback as (connectInfo: ProviderConnectInfo) => void)
				break
			case 'close':
			case 'disconnect':
				onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				break
			case 'chainChanged':
				onChainChangedCallBacks.delete(callback as (chainId: string) => void)
				break
			default:
				exhaustivenessCheck(kind)
		}
		return inpageWindow.ethereum
	}

	const WindowEthereumEnable = async () => WindowEthereumRequest({ method: 'eth_requestAccounts' })

	const getAccountsFromSigner = async () => {
		if (signerWindowEthereumRequest === undefined) return
		try {
			const reply = await signerWindowEthereumRequest({ method: 'eth_accounts', params: [] })
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			if (!isStringArray(reply)) throw new Error('Signer did not return a string array')
			signerAccounts = reply
			await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: signerAccounts, requestAccounts: false }] })
			return
		} catch (error: unknown) {
			if (getErrorCodeAndMessage(error)) return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error }] })
			if (error instanceof Error) return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }] })
			return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }] })
		}
	}

	const requestAccountsFromSigner = async () => {
		if (signerWindowEthereumRequest === undefined) return
		if (pendingSignerAddressRequest !== undefined) {
			await pendingSignerAddressRequest
			await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: signerAccounts, requestAccounts: true }] })
			return
		}
		pendingSignerAddressRequest = new InterceptorFuture<boolean>()
		try {
			const reply = await signerWindowEthereumRequest({ method: 'eth_requestAccounts', params: [] })
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			if (!isStringArray(reply)) throw new Error('Signer did not return a string array')
			signerAccounts = reply
			await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: signerAccounts, requestAccounts: true }] })
			return
		} catch (error: unknown) {
			if (getErrorCodeAndMessage(error)) return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error }] })
			if (error instanceof Error) return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }] })
			return await sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }] })
		} finally {
			pendingSignerAddressRequest.resolve(true)
			pendingSignerAddressRequest = undefined
		}
	}

	const requestChainIdFromSigner = async () => {
		if (signerWindowEthereumRequest === undefined) return
		try {
			const reply = await signerWindowEthereumRequest({ method: 'eth_chainId', params: [] })
			if (typeof reply !== 'string') return
			return await sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [reply] })
		} catch (error) {
			console.error('failed to get chain Id from signer')
			console.error(error)
			return await sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: ['0x1'] })
		}
	}

	const requestChangeChainFromSigner = async (chainId: string) => {
		if (signerWindowEthereumRequest === undefined) return
		try {
			const reply = await signerWindowEthereumRequest({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
			if (reply !== null) return
			await sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [{ accept: true, chainId }] })
		} catch (error: unknown) {
			if (getErrorCodeAndMessage(error) && (error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
				await sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [{ accept: false, chainId, error }] })
			}
			throw error
		}
	}

	const handleReplyRequest = async (replyRequest: InterceptedRequestForwardWithResult): Promise<void> => {
		try {
			if (replyRequest.subscription !== undefined) {
				for (const callback of onMessageCallBacks) callback({ type: 'eth_subscription', data: replyRequest.result })
				return
			}
			switch (replyRequest.method) {
				case 'accountsChanged': {
					const reply = replyRequest.result as readonly string[]
					const replyAddress = reply[0] ?? ''
					if (currentAddress === replyAddress) return
					currentAddress = replyAddress
					if (metamaskCompatibilityMode && inpageWindow.ethereum !== undefined) {
						try { inpageWindow.ethereum.selectedAddress = replyAddress } catch {}
						if ('web3' in inpageWindow && inpageWindow.web3 !== undefined) {
							try { inpageWindow.web3.accounts = reply } catch {}
						}
					}
					for (const callback of onAccountsChangedCallBacks) callback(reply)
					return
				}
				case 'connect':
					if (connected) return
					connected = true
					for (const callback of onConnectCallBacks) callback({ chainId: replyRequest.result as string })
					return
				case 'disconnect':
					if (!connected) return
					connected = false
					for (const callback of onDisconnectCallBacks) {
						callback({ name: 'disconnect', code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User refused access to the wallet' })
					}
					return
				case 'chainChanged': {
					const reply = replyRequest.result as string
					if (activeChainId === reply) return
					activeChainId = reply
					if (metamaskCompatibilityMode && signerWindowEthereumRequest === undefined && inpageWindow.ethereum !== undefined) {
						try { inpageWindow.ethereum.chainId = reply } catch {}
						try { inpageWindow.ethereum.networkVersion = Number(reply).toString(10) } catch {}
					}
					for (const callback of onChainChangedCallBacks) callback(reply)
					return
				}
				case 'request_signer_to_eth_requestAccounts':
					await requestAccountsFromSigner()
					return
				case 'request_signer_to_eth_accounts':
					await getAccountsFromSigner()
					return
				case 'request_signer_to_wallet_switchEthereumChain':
					await requestChangeChainFromSigner(replyRequest.result as string)
					return
				case 'request_signer_chainId':
					await requestChainIdFromSigner()
					return
				default:
					return
			}
		} finally {
			if (replyRequest.requestId === undefined) return
			const pending = outstandingRequests.get(replyRequest.requestId)
			if (pending === undefined) return
			pending.resolve(replyRequest.result)
		}
	}

	const checkIfCoinbaseInjectionMessageAndInject = (messageEvent: unknown) => {
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('type' in messageEvent.data)
			|| !('data' in messageEvent.data)
			|| messageEvent.data.data === null
			|| typeof messageEvent.data.data !== 'object'
			|| !('action' in messageEvent.data.data)
		) return
		if (messageEvent.data.type === 'extensionUIRequest' && messageEvent.data.data.action === 'loadWalletLinkProvider') {
			listener.injectEthereumIntoWindow()
		}
	}

	const parseRpcError = (maybeErrorObject: unknown) => {
		if (typeof maybeErrorObject !== 'object' || maybeErrorObject === null) {
			return EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { rawError: maybeErrorObject })
		}
		if (
			'code' in maybeErrorObject && typeof maybeErrorObject.code === 'number'
			&& 'message' in maybeErrorObject && typeof maybeErrorObject.message === 'string'
		) {
			return EthereumJsonRpcError(
				maybeErrorObject.code,
				maybeErrorObject.message,
				'data' in maybeErrorObject && typeof maybeErrorObject.data === 'object' && maybeErrorObject.data !== null ? maybeErrorObject.data : undefined,
			)
		}
		return EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', maybeErrorObject)
	}

	const onMessage = async (messageEvent: unknown) => {
		checkIfCoinbaseInjectionMessageAndInject(messageEvent)
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('interceptorApproved' in messageEvent.data)
		) return
		try {
			if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) throw new Error('window.ethereum missing')
			if (!('method' in messageEvent.data)) throw new Error('missing method field')
			if (!('type' in messageEvent)) throw new Error('missing type field')
			const forwardRequest = messageEvent.data as InterceptedRequestForward
			if (forwardRequest.type === 'result' && 'error' in forwardRequest) {
				if (forwardRequest.requestId === undefined) throw EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
				const pending = outstandingRequests.get(forwardRequest.requestId)
				if (pending === undefined) throw EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
				return pending.reject(EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data))
			}
			if (forwardRequest.type === 'result' && 'result' in forwardRequest) {
				if (metamaskCompatibilityMode && signerWindowEthereumRequest === undefined && inpageWindow.ethereum !== undefined) {
					switch (messageEvent.data.method) {
						case 'eth_requestAccounts':
						case 'eth_accounts': {
							if (!Array.isArray(forwardRequest.result) || forwardRequest.result === null) throw new Error('wrong type')
							const addrArray = forwardRequest.result as string[]
							const addr = addrArray[0] ?? ''
							try { inpageWindow.ethereum.selectedAddress = addr } catch {}
							if ('web3' in inpageWindow && inpageWindow.web3 !== undefined) {
								try { inpageWindow.web3.accounts = addrArray } catch {}
							}
							currentAddress = addr
							break
						}
						case 'eth_chainId': {
							if (typeof forwardRequest.result !== 'string') throw new Error('wrong type')
							const chainId = forwardRequest.result
							try { inpageWindow.ethereum.chainId = chainId } catch {}
							try { inpageWindow.ethereum.networkVersion = Number(chainId).toString(10) } catch {}
							activeChainId = chainId
							break
						}
					}
				}
				await handleReplyRequest(forwardRequest)
				return
			}
			if (forwardRequest.type !== 'forwardToSigner') throw new Error('type: forwardToSigner missing')
			if (forwardRequest.requestId === undefined) throw new Error('requestId missing')
			const pendingRequest = outstandingRequests.get(forwardRequest.requestId)
			if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
			const signerRequest = signerWindowEthereumRequest
			if (signerRequest === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')

			const signerReply = await (async () => {
				try {
					const reply = await signerRequest({ method: forwardRequest.method, params: 'params' in forwardRequest ? forwardRequest.params : [] })
					return { success: true as const, forwardRequest, reply }
				} catch (error: unknown) {
					return { success: false as const, forwardRequest, error }
				}
			})()

			try {
				if ('replyWithSignersReply' in forwardRequest) {
					if (signerReply.success) {
						await handleReplyRequest({
							requestId: forwardRequest.requestId,
							interceptorApproved: true,
							method: forwardRequest.method,
							type: 'result',
							result: signerReply.reply,
						})
						return
					}
					return pendingRequest.reject(parseRpcError(signerReply.error))
				}
				await sendMessageToBackgroundPage({ method: 'signer_reply', params: [signerReply] })
			} catch (error: unknown) {
				if (error instanceof Error) return pendingRequest.reject(error)
				return pendingRequest.reject(parseRpcError(error))
			}
		} catch (error: unknown) {
			console.error(messageEvent)
			console.error(error)
			await sendMessageToBackgroundPage({ method: 'InterceptorError', params: [error] })
			const pendingRequestId = 'requestId' in messageEvent.data && typeof messageEvent.data.requestId === 'number' ? messageEvent.data.requestId : undefined
			if (pendingRequestId === undefined) return
			const pendingRequest = outstandingRequests.get(pendingRequestId)
			if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
			if (error instanceof Error) return pendingRequest.reject(error)
			return pendingRequest.reject(parseRpcError(error))
		}
	}

	const enableMetamaskCompatibilityMode = (enable: boolean) => {
		metamaskCompatibilityMode = enable
		if (!enable || inpageWindow.ethereum === undefined) return
		if (!('isMetamask' in inpageWindow.ethereum)) {
			try { inpageWindow.ethereum.isMetaMask = true } catch {}
		}
		if ('web3' in inpageWindow && inpageWindow.web3 !== undefined) {
			try { inpageWindow.web3.currentProvider = inpageWindow.ethereum } catch {}
			return
		}
		try { inpageWindow.web3 = { accounts: [], currentProvider: inpageWindow.ethereum } } catch {}
	}

	const connectToSigner = async (signerName: Signer) => {
		currentSigner = signerName
		const connectSigner = async (): Promise<{ metamaskCompatibilityMode: boolean, activeAddress: string }> => {
			const connectSignerReply = await sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [true, signerName] })
			if (
				typeof connectSignerReply === 'object' && connectSignerReply !== null
				&& 'metamaskCompatibilityMode' in connectSignerReply && typeof connectSignerReply.metamaskCompatibilityMode === 'boolean'
				&& 'activeAddress' in connectSignerReply && typeof connectSignerReply.activeAddress === 'string'
			) {
					currentAddress = connectSignerReply.activeAddress
					if (connectSignerReply.metamaskCompatibilityMode && inpageWindow.ethereum !== undefined) {
						try { inpageWindow.ethereum.selectedAddress = currentAddress } catch {}
					}
					return {
						metamaskCompatibilityMode: connectSignerReply.metamaskCompatibilityMode,
						activeAddress: connectSignerReply.activeAddress,
					}
				}
			throw new Error('Failed to parse connected_to_signer reply')
		}

		const signerConnection = await connectSigner()
		enableMetamaskCompatibilityMode(signerConnection.metamaskCompatibilityMode)
		if (signerName !== 'NoSigner') await requestChainIdFromSigner()
	}

	const unsupportedMethods = (windowEthereum: WindowEthereum & UnsupportedWindowEthereumMethods | undefined) => {
		const unsupportedError = (method: string) => {
			console.error(`The application tried to call a deprecated or non-standard method: '${ method }'. Please contact the application developer to fix this issue.`)
		}
		return {
			once: (() => unsupportedError('window.ethereum.once()')).bind(windowEthereum),
			prependListener: (() => unsupportedError('window.ethereum.prependListener()')).bind(windowEthereum),
			prependOnceListener: (() => unsupportedError('window.ethereum.prependOnceListener()')).bind(windowEthereum),
			_metamask: {
				isUnlocked: async () => {
					unsupportedError('window.ethereum._metamask.isUnlocked()')
					return connected
				},
				requestBatch: async () => unsupportedError('window.ethereum._metamask.requestBatch()'),
			},
		}
	}

	const onPageLoad = () => {
		function announceProvider() {
			const info: EIP6963ProviderInfo = {
				uuid: '200ecd95-afe4-4684-bce7-0f2f8bdd3498',
				name: 'The Interceptor',
				icon: 'data:image/svg+xml,%3Csvg%20width%3D%2232%22%20height%3D%2232%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M8%2021.32c.03%200%20.06%200%20.08-.01h.05c.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.07-.01.1-.02.01%200%20.03%200%20.04-.01.04-.01.08-.01.12-.02h.02c.1-.02.19-.04.29-.07.01%200%20.02-.01.03-.01l.12-.03c.02%200%20.03-.01.05-.01l.1-.03c.01%200%20.01%200%20.02-.01%201.38-.44%203.08-1.52%205.14-3.68l2.07%201.52.79-5.87%203.29-2.67S8.43%205.37%206.76%205.07c-1.67-.29-4.29%201.5-5.37%202.67-.89.96.07%204.21.45%205.37.07.23.32.35.55.27l.04-.01c.17-.06.28-.22.29-.4.01-.24.1-.48.26-.68l.18-.23c.14-.17.32-.3.52-.37l2.79-.98c.36-.13.76-.07%201.07.16l4.49%203.29c.32.23.5.61.47%201l-.01.1c-.02.31-.16.6-.39.8l-.01.01-.28.25-.09.08-.2.17-.1.08c-.06.06-.13.11-.19.17l-.08.07c-.09.08-.18.15-.27.23l-.02.01c-.08.07-.16.14-.24.2l-.08.07-.18.15-.08.07c-.06.05-.12.1-.18.14l-.07.06c-.08.07-.16.13-.24.19l-.02.02c-.07.06-.14.11-.21.17l-.07.05c-.05.04-.11.08-.16.13l-.07.05c-.06.04-.11.08-.16.13l-.05.04c-.07.06-.14.11-.21.16l-.03.04H8.8c-.06.05-.12.09-.18.14l-.06.04c-.05.04-.1.07-.14.1l-.06.04c-.05.04-.1.07-.15.11l-.04.03c-.01.01-.02.01-.03.02l-.01-.01h.04l-1.21-1.3c-.87-1.53.65-3.52%201.55-4.5a.31.31%200%200%200-.04-.45l-1.5-1.1a.31.31%200%200%200-.28-.04l-2.56.89c-.05.02-.1.05-.14.1-.08.1-.09.23-.03.34l1.3%202.26c.05.09.05.19.01.29-.3.61-1.42%202.98-.8%203.64h-.02s.36.68%201.14%201.23c.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.03.02.04.02.01.01.02.01.04.02.01.01.03.02.04.02.01.01.03.01.04.02s.03.02.04.02c-.01.05.01.06.02.07.02.01.03.02.05.02.01.01.02.01.04.02s.03.02.05.02c.01.01.02.01.04.02.01.01.03.02.05.03.01%200%20.02.01.03.01.03.01.06.03.09.04.01%200%20.01%200%20.02.01.03.01.05.02.08.03.01%200%20.02.01.03.01.02.01.04.02.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02%200%20.04.01.07.01.01%200%20.03.01.04.01.02%200%20.05.01.07.01.01%200%20.03%200%20.04.01.03%200%20.05.01.08.01.01%200%20.02%200%20.03.01.03%200%20.06.01.09.01h.02c.08.01.16.01.24.02zm3.85-10.75c0-.57.46-1.03%201.03-1.03s1.03.46%201.03%201.03-.46%201.03-1.03%201.03-1.03-.46-1.03-1.03m3.44%2012.15c-2.88-.17-4.88-.79-5.41-.98l-.01.01-.33.11-.02.01c-.04.01-.08.02-.12.04h-.01l-.04.01c-.04.01-.09.02-.13.04h-.01l-.03.01c-.11.03-.23.06-.34.08h-.02l-.14.03-.04.01h-.01c-.04.01-.08.01-.12.02l-.04-.01h-.01c-.04%200-.07.01-.11.01h-.06c-.03%200-.07.01-.1.01h-.06c-.03%200-.07%200-.1.01h-.12l-.09%204.4h3.88l.3-2.38c.46.2.91.41%201.43.48v.88h-.01v1.45h3.88l.06-1.06c.04-.35.1-.76.15-1.19%201.11-.11%202.2-.36%203.26-.78.4.96.9%202.44.9%202.44h4.2l.13-5.44a24.1%2024.1%200%200%201-9.25%201.83c-.52%200-1.01-.02-1.46-.04%22%20fill%3D%22currentColor%22%2F%3E%3Cpath%20d%3D%22M30.76%2014.1c-.51-1.23-1.69-2.01-2.88-2.67.11-.24.18-.5.18-.78%200-1.04-.84-1.88-1.88-1.88s-1.88.84-1.88%201.88.84%201.88%201.88%201.88c.47%200%20.89-.19%201.22-.48%201.02%201.06%202.06%202.52-1.17%204l-.23-.63c-.5%200-1.51.5-1.51.5l.34-1c-.84-.5-2.01-.34-2.01-.34l.67-.84c-.7-.7-2.32-.58-2.85-.52.13-.06.33-.23.67-.65-.74-.3-1.32-.36-1.77-.3l-1.48%201.2-.75%205.55-.19%201.38-.03.2-2.71-1.99c-1.17%201.14-2.3%202.01-3.37%202.6%202.32.6%208.4%201.69%2015.01-1.19v-.01c2.66-1.14%205.9-3.12%204.74-5.91M19.3%2019.61c-.36-1.49-.09-3.36.67-4.69.36%201.49.1%203.35-.67%204.69m3.02%200c-.35-.96-.08-2.07.67-2.76.35.95.08%202.07-.67%202.76%22%20fill%3D%22currentColor%22%2F%3E%3C%2Fsvg%3E',
				rdns: 'dark.florist',
			}

			if (inpageWindow.ethereum === undefined || !inpageWindow.ethereum.isInterceptor) listener.injectEthereumIntoWindow()
			const provider = inpageWindow.ethereum
			if (provider === undefined) throw new Error('The Interceptor provider was not initialized')
			window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
		}
		window.addEventListener('eip6963:requestProvider', () => { announceProvider() })
		announceProvider()
	}

	const injectEthereumIntoWindow = () => {
		if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) {
			inpageWindow.ethereum = {
				isInterceptor: true,
				isConnected: WindowEthereumIsConnected,
				request: WindowEthereumRequest,
				send: WindowEthereumSend,
				sendAsync: WindowEthereumSendAsync,
				on: WindowEthereumOn,
				removeListener: WindowEthereumRemoveListener,
				enable: WindowEthereumEnable,
				...unsupportedMethods(inpageWindow.ethereum),
			}
			connected = true
			connectToSigner('NoSigner')
			return
		}
		if (inpageWindow.ethereum.isInterceptor) return

		inpageWindow.ethereum.on('accountsChanged', (accounts: readonly string[]) => {
			WindowEthereumRequest({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts, requestAccounts: false }] })
		})
		inpageWindow.ethereum.on('connect', (_connectInfo: ProviderConnectInfo) => {
			connectToSigner(currentSigner)
		})
		inpageWindow.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [false, currentSigner] })
		})
		inpageWindow.ethereum.on('chainChanged', (chainId: string) => {
			const params = /\d/.test(chainId) ? [`0x${ parseInt(chainId).toString(16) }`] : [chainId]
			WindowEthereumRequest({ method: 'signer_chainChanged', params })
		})

		connected = !inpageWindow.ethereum.isConnected || inpageWindow.ethereum.isConnected()
		signerWindowEthereumRequest = inpageWindow.ethereum.request.bind(inpageWindow.ethereum)

		if (inpageWindow.ethereum.isBraveWallet || inpageWindow.ethereum.providerMap || inpageWindow.ethereum.isCoinbaseWallet) {
			const signerName = inpageWindow.ethereum.providerMap || inpageWindow.ethereum.isCoinbaseWallet ? 'CoinbaseWallet' : 'Brave'
			const oldWinEthereum = (inpageWindow.ethereum.providerMap ? inpageWindow.ethereum.providerMap.get('CoinbaseWallet') : undefined) ?? inpageWindow.ethereum
			inpageWindow.ethereum = {
				isInterceptor: true,
				isConnected: WindowEthereumIsConnected,
				request: WindowEthereumRequest,
				send: WindowEthereumSend,
				sendAsync: WindowEthereumSendAsync,
				on: WindowEthereumOn,
				removeListener: WindowEthereumRemoveListener,
				enable: WindowEthereumEnable,
				...unsupportedMethods(oldWinEthereum),
			}
			connectToSigner(signerName)
			return
		}

		Object.assign(inpageWindow.ethereum, {
			isInterceptor: true,
			isConnected: WindowEthereumIsConnected,
			request: WindowEthereumRequest,
			send: WindowEthereumSend,
			sendAsync: WindowEthereumSendAsync,
			on: WindowEthereumOn,
			removeListener: WindowEthereumRemoveListener,
			enable: WindowEthereumEnable,
			...unsupportedMethods(inpageWindow.ethereum),
		})
		connectToSigner(inpageWindow.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
	}

	const listener: InterceptorMessageListener = {
		onMessage,
		injectEthereumIntoWindow,
	}

	injectEthereumIntoWindow()
	onPageLoad()

	return listener
}

function injectInterceptor() {
	const interceptorMessageListener = InterceptorMessageListener()
	window.addEventListener('message', interceptorMessageListener.onMessage)
	window.dispatchEvent(new Event('ethereum#initialized'))

	// listen if Metamask injects (I think this method of injection is only supported by Metamask currently) their payload, and if so, reinject Interceptor
	const interceptorCapturedDispatcher = window.dispatchEvent
	window.dispatchEvent = (event: Event) => {
		interceptorCapturedDispatcher(event)
		if (!(typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string')) return true
		if (event.type !== 'ethereum#initialized') return true
		interceptorMessageListener.injectEthereumIntoWindow()
		window.dispatchEvent = interceptorCapturedDispatcher
		return true
	}
}

injectInterceptor()
