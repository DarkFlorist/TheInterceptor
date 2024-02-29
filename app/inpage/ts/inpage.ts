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
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
		onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | undefined | null
	): PromiseLike<TResult1 | TResult2> => {
		return this.promise.then(onfulfilled, onrejected)
	}

	public readonly resolve = (value: T | PromiseLike<T>) => this.resolveFunction!(value)
	public readonly reject = (reason: Error) => this.rejectFunction!(reason)
}

class EthereumJsonRpcError extends Error {
	constructor(public readonly code: number, message: string, public readonly data?: object) {
		super(message)
		this.name = this.constructor.name
	}
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

type InterceptedRequestForwardToSigner = InterceptedRequestBase & { readonly type: 'forwardToSigner' }

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
interface Window {
	dispatchEvent: (event: Event) => boolean
	ethereum?: WindowEthereum
	web3?: {
		currentProvider: WindowEthereum
		accounts: readonly string[]
	}
}

interface EIP6963ProviderInfo {
	uuid: string
	name: string
	icon: string
	rdns: string
}

type SingleSendAsyncParam = { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] }

type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'

class InterceptorMessageListener {
	private connected: boolean = false
	private requestId: number = 0
	private metamaskCompatibilityMode: boolean = false
	private signerWindowEthereumRequest: EthereumRequest | undefined = undefined

	private readonly outstandingRequests: Map<number, InterceptorFuture<unknown> > = new Map()

	private readonly onMessageCallBacks: Set<((message: ProviderMessage) => void)> = new Set()
	private readonly onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)> = new Set()
	private readonly onAccountsChangedCallBacks: Set<((accounts: readonly string[]) => void)> = new Set()
	private readonly onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)> = new Set()
	private readonly onChainChangedCallBacks: Set<((chainId: string) => void)> = new Set()

	private waitForAccountsFromWallet: InterceptorFuture<boolean> | undefined = undefined
	private signerAccounts: string[] = []
	private pendingSignerAddressRequest: InterceptorFuture<boolean> | undefined = undefined

	public constructor() {
		this.injectEthereumIntoWindow()
		this.onPageLoad()
	}

	private readonly WindowEthereumIsConnected = () => this.connected

	private readonly sendMessageToBackgroundPage = async (messageMethodAndParams: MessageMethodAndParams) => {
		this.requestId++
		const pendingRequestId = this.requestId
		const future = new InterceptorFuture<unknown>()
		this.outstandingRequests.set(pendingRequestId, future)
		try {
			window.postMessage({
				interceptorRequest: true,
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
				usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
				requestId: pendingRequestId,
			}, '*')
			return await future
		} finally {
			this.outstandingRequests.delete(pendingRequestId)
		}
	}

	// sends a message to interceptors background script
	private readonly WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }) => {
		if (this.waitForAccountsFromWallet !== undefined) await this.waitForAccountsFromWallet // wait for wallet to return to us before continuing with other requests
		try {
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			return await this.sendMessageToBackgroundPage({ method: methodAndParams.method, params: methodAndParams.params })
		} catch (error: unknown) {
			if (error instanceof Error) throw error
			throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, `Unexpected thrown value.`, { error: error, request: methodAndParams })
		}
	}

	private readonly WindowEthereumSend = (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] } | string, maybeCallBack: undefined | ((error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void)) => {
		const fullPayload = typeof payload === 'string' ? { method: payload, id: 1, params: [] } : payload
		if (maybeCallBack !== undefined && typeof maybeCallBack === 'function') return this.WindowEthereumSendAsync(fullPayload, maybeCallBack)
		if (this.metamaskCompatibilityMode) {
			if (window.ethereum === undefined) throw new Error('window.ethereum is missing')
			switch (fullPayload.method) {
				case 'eth_coinbase': 
				case 'eth_accounts': return { jsonrpc: '2.0', id: fullPayload.id, result: window.ethereum.selectedAddress === undefined || window.ethereum.selectedAddress === null ? [] : [window.ethereum.selectedAddress] }
				case 'net_version': return { jsonrpc: '2.0', id: fullPayload.id, result: window.ethereum.networkVersion }
				case 'eth_chainId': return { jsonrpc: '2.0', id: fullPayload.id, result: window.ethereum.chainId }
				default: throw new EthereumJsonRpcError(METAMASK_INVALID_METHOD_PARAMS, `Invalid method parameter for window.ethereum.send: ${ fullPayload.method }`)
			}
		}
		throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, 'Method not supported (window.ethereum.send).')
	}
	private readonly WindowEthereumSendAsync = async (payload: SingleSendAsyncParam | SingleSendAsyncParam[], callback: (error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void) => {
		const payloadArray = Array.isArray(payload) ? payload : [payload]
		payloadArray.map((param) => this.WindowEthereumRequest(param)
			.then(result => callback(null, { jsonrpc: '2.0', id: param.id, result }))
			// since `request(...)` only throws things shaped like `JsonRpcError`, we can rely on it having those properties.
			.catch((error) => {
				if (InterceptorMessageListener.getErrorCodeAndMessage(error)) {
					const data = 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data : {}
					const stack = 'stack' in error && typeof error.stack === 'string' ? { stack: error.stack } : {}
					return callback({
						jsonrpc: '2.0',
						id: param.id,
						error: { 
							code: error.code, 
							message: error.message, 
							data: { ...data, ...stack }
						}
					}, null)
				}
				return callback({
					jsonrpc: '2.0',
					id: param.id,
					error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR }
				}, null)
			})
		)
	}

	static exhaustivenessCheck = (_thing: never) => {}

	private readonly WindowEthereumOn = (kind: OnMessage, callback: AnyCallBack) => {
		if (window.ethereum === undefined) throw new Error('window.ethereum is not defined')
		switch (kind) {
			case 'accountsChanged':
				this.onAccountsChangedCallBacks.add(callback as (accounts: readonly string[]) => void)
				break
			case 'message':
				this.onMessageCallBacks.add(callback as (message: ProviderMessage) => void)
				break
			case 'connect':
				this.onConnectCallBacks.add(callback as (connectInfo: ProviderConnectInfo) => void)
				break
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				this.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				break
			case 'disconnect':
				this.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				break
			case 'chainChanged':
				this.onChainChangedCallBacks.add(callback as (chainId: string) => void)
				break
			default: InterceptorMessageListener.exhaustivenessCheck(kind)
		}
		return window.ethereum
	}

	private readonly WindowEthereumRemoveListener = (kind: OnMessage, callback: AnyCallBack) => {
		if (window.ethereum === undefined) throw new Error('window.ethereum is not defined')
		switch (kind) {
			case 'accountsChanged':
				this.onAccountsChangedCallBacks.delete(callback as (accounts: readonly string[]) => void)
				break
			case 'message':
				this.onMessageCallBacks.delete(callback as (message: ProviderMessage) => void)
				break
			case 'connect':
				this.onConnectCallBacks.delete(callback as (connectInfo: ProviderConnectInfo) => void)
				break
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				this.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				break
			case 'disconnect':
				this.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				break
			case 'chainChanged':
				this.onChainChangedCallBacks.delete(callback as (chainId: string) => void)
				break
			default: InterceptorMessageListener.exhaustivenessCheck(kind)
		}
		return window.ethereum
	}

	private readonly WindowEthereumEnable = async () => this.WindowEthereumRequest({ method: 'eth_requestAccounts' })

	// attempts to call signer for eth_accounts
	private readonly getAccountsFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		try {
			const reply = await this.signerWindowEthereumRequest({ method: 'eth_accounts', params: [] })
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: false }] })
			return
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error)) return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error }] })
			if (error instanceof Error) return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }] })
			return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }] })
		} finally {
			if (this.waitForAccountsFromWallet === undefined) return
			this.waitForAccountsFromWallet.resolve(true)
			this.waitForAccountsFromWallet = undefined
		}
	}

	private static isStringArray(arr: unknown[]): arr is string[] {
		return arr.every(item => typeof item === "string");
	}

	// attempts to call signer for eth_requestAccounts
	private readonly requestAccountsFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		if (this.pendingSignerAddressRequest !== undefined) {
			await this.pendingSignerAddressRequest
			await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: true }] })
			return
		}
		this.pendingSignerAddressRequest = new InterceptorFuture()
		try {
			const reply = await this.signerWindowEthereumRequest({ method: 'eth_requestAccounts', params: [] })
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			if (!InterceptorMessageListener.isStringArray(reply)) throw new Error('Signer did not return a string array')
			this.signerAccounts = reply
			await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: true }] })
			return
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error)) return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error }] })
			if (error instanceof Error) return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }] })
			return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: true, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }] })
		} finally {
			this.pendingSignerAddressRequest.resolve(true)
			this.pendingSignerAddressRequest = undefined
		}
	}

	private readonly requestChainIdFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		try {
			const reply = await this.signerWindowEthereumRequest({ method: 'eth_chainId', params: [] })
			if (typeof reply !== 'string') return
			return await this.sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [ reply ] })
		} catch(e) {
			console.error('failed to get chain Id from signer')
			console.error(e)
			return await this.sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [ '0x1' ] })
		}
	}

	private static readonly getErrorCodeAndMessage = (error: unknown): error is { code: number, message: string } => {
		if (typeof error !== 'object') return false
		if (error === null) return false
		if (!('code' in error) || !('message' in error)) return false
		if (typeof (error as { code: unknown }).code !== 'number') return false
		if (typeof (error as { message: unknown }).message !== 'string') return false
		return true
	}

	private readonly requestChangeChainFromSigner = async (chainId: string) => {
		if (this.signerWindowEthereumRequest === undefined) return

		try {
			const reply = await this.signerWindowEthereumRequest({ method: 'wallet_switchEthereumChain', params: [ { 'chainId': chainId } ] })
			if (reply !== null) return
			await this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: true, chainId: chainId } ] })
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error) && (error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
				await this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: false, chainId: chainId } ] })
			}
			throw error
		}
	}

	private readonly handleReplyRequest = async(replyRequest: InterceptedRequestForwardWithResult) => {
		try {
			if (replyRequest.subscription !== undefined) {
				return this.onMessageCallBacks.forEach((callback) => callback({ type: 'eth_subscription', data: replyRequest.result }))
			}
			// inform callbacks
			switch (replyRequest.method) {
				case 'accountsChanged': {
					const reply = replyRequest.result as readonly string[]
					if (this.metamaskCompatibilityMode && window.ethereum !== undefined) {
						window.ethereum.selectedAddress = reply.length > 0 ? reply[0] : ''
						if ('web3' in window && window.web3 !== undefined) window.web3.accounts = reply
					}
					return this.onAccountsChangedCallBacks.forEach((callback) => callback(reply))
				}
				case 'connect': {
					this.connected = true
					return this.onConnectCallBacks.forEach((callback) => callback({ chainId: replyRequest.result as string }))
				}
				case 'disconnect': {
					this.connected = false
					return this.onDisconnectCallBacks.forEach((callback) => callback({
						name: 'disconnect',
						code: METAMASK_ERROR_USER_REJECTED_REQUEST,
						message: 'User refused access to the wallet'
					}))
				}
				case 'chainChanged': {
					const reply = replyRequest.result as string
					if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && window.ethereum !== undefined) {
						window.ethereum.chainId = reply
						window.ethereum.networkVersion = Number(reply).toString(10)
					}
					return this.onChainChangedCallBacks.forEach((callback) => callback(reply))
				}
				case 'request_signer_to_eth_requestAccounts': return await this.requestAccountsFromSigner()
				case 'request_signer_to_eth_accounts': return await this.getAccountsFromSigner()
				case 'request_signer_to_wallet_switchEthereumChain': return await this.requestChangeChainFromSigner(replyRequest.result as string)
				case 'request_signer_chainId': return await this.requestChainIdFromSigner()
				default: break
			}
		} finally {
			if (replyRequest.requestId === undefined) return
			const pending = this.outstandingRequests.get(replyRequest.requestId)
			if (pending === undefined) return
			return pending.resolve(replyRequest.result)
		}
	}

	// coinbase wallet sends different kind of message on inject, this function identifies that and reinjects
	private checkIfCoinbaseInjectionMessageAndInject(messageEvent: unknown) {
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
			return this.injectEthereumIntoWindow()
		}
		return
	}

	public readonly onMessage = async (messageEvent: unknown) => {
		this.checkIfCoinbaseInjectionMessageAndInject(messageEvent)
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('interceptorApproved' in messageEvent.data)
		) return
		if (!('ethereum' in window) || !window.ethereum) throw new Error('window.ethereum missing')
		if (!('method' in messageEvent.data)) throw new Error('missing method field')
		if (!('type' in messageEvent)) throw new Error('missing type field')
		const forwardRequest = messageEvent.data as InterceptedRequestForward //use 'as' here as we don't want to inject funtypes here
		if (forwardRequest.type === 'result' && 'error' in forwardRequest) {
			if (forwardRequest.requestId === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
			const pending = this.outstandingRequests.get(forwardRequest.requestId)
			if (pending === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
			return pending.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data))
		}
		if (forwardRequest.type === 'result' && 'result' in forwardRequest) {
			if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && window.ethereum !== undefined) {
				switch (messageEvent.data.method) {
					case 'eth_requestAccounts':
					case 'eth_accounts': {
						if (!Array.isArray(forwardRequest.result) || forwardRequest.result === null) throw new Error('wrong type')
						const addrArray = forwardRequest.result as string[]
						window.ethereum.selectedAddress = addrArray.length > 0 ? addrArray[0] : ''
						if ('web3' in window && window.web3 !== undefined) window.web3.accounts = addrArray
						break
					}
					case 'eth_chainId': {
						if (typeof forwardRequest.result !== 'string') throw new Error('wrong type')
						const chainId = forwardRequest.result as string
						window.ethereum.chainId = chainId
						window.ethereum.networkVersion = Number(chainId).toString(10)
						break
					}
				}
			}
			await this.handleReplyRequest(forwardRequest)
			return
		}
		if (forwardRequest.type !== 'forwardToSigner') throw new Error('type: forwardToSigner missing')
		if (forwardRequest.requestId === undefined) throw new Error('requestId missing')
		const pendingRequest = this.outstandingRequests.get(forwardRequest.requestId)
		if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
		const signerRequest = this.signerWindowEthereumRequest
		if (signerRequest === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
		
		const sendToSignerWithCatchError = async () => {
			try {
				const reply = await signerRequest({ method: forwardRequest.method, params: 'params' in forwardRequest ? forwardRequest.params : [] })
				return { success: true, forwardRequest, reply }
			} catch(error: unknown) {
				return { success: false, forwardRequest, error }
			}
		}
		const signerReply = await sendToSignerWithCatchError()
		try {
			await this.sendMessageToBackgroundPage({ method: 'signer_reply', params: [ signerReply ] })
		} catch(error: unknown) {
			if (error instanceof Error) return pendingRequest.reject(error)
			if (typeof error === 'object' && error !== null
				&& 'code' in error && error.code !== undefined && typeof error.code === 'number'
				&& 'message' in error && error.message !== undefined && typeof error.message === 'string'
			) {
				return pendingRequest.reject(new EthereumJsonRpcError(error.code, error.message, 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data : undefined))
			}
			// if the signer we are connected threw something besides an Error, wrap it up in an error
			pendingRequest.reject(new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, `Unexpected thrown value.`, { error: error }))
		}
	}

	private enableMetamaskCompatibilityMode(enable: boolean) {
		this.metamaskCompatibilityMode = enable
		if (enable) {
			if (window.ethereum === undefined) return
			if (!('isMetamask' in window.ethereum)) window.ethereum.isMetaMask = true
			if ('web3' in window && window.web3 !== undefined) {
				window.web3.currentProvider = window.ethereum
			} else {
				window.web3 = { accounts: [], currentProvider: window.ethereum }
			}
		}
	}

	private readonly connectToSigner = async (signerName: 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave' | 'CoinbaseWallet') => {
		const connectToSigner = async (): Promise<{ metamaskCompatibilityMode: boolean }> => {
			const comppatibilityMode = await this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [signerName] })
			if (typeof comppatibilityMode === 'object' && comppatibilityMode !== null
				&& 'metamaskCompatibilityMode' in comppatibilityMode && comppatibilityMode.metamaskCompatibilityMode !== null && comppatibilityMode.metamaskCompatibilityMode !== undefined && typeof comppatibilityMode.metamaskCompatibilityMode === 'boolean') {
				return comppatibilityMode as { metamaskCompatibilityMode: boolean }
			}
			throw new Error('Failed to parse connected_to_signer reply')
		}

		if (signerName !== 'NoSigner') {
			this.waitForAccountsFromWallet = new InterceptorFuture()
			this.enableMetamaskCompatibilityMode((await connectToSigner()).metamaskCompatibilityMode)
			await this.requestChainIdFromSigner()
			await this.getAccountsFromSigner()
		} else {
			this.enableMetamaskCompatibilityMode((await connectToSigner()).metamaskCompatibilityMode)
		}
	}

	private readonly unsupportedMethods = (windowEthereum: WindowEthereum & UnsupportedWindowEthereumMethods | undefined) => {
		const unsupportedError = (method: string) => {
			return console.error(`The application tried to call a deprecated or non-standard method: '${ method }'. Please contact the application developer to fix this issue.`)
		}
		return {
			once: (() => { return unsupportedError('window.ethereum.once()') }).bind(windowEthereum),
			prependListener: (() => { return unsupportedError('window.ethereum.prependListener()') }).bind(windowEthereum),
			prependOnceListener: (() => { return unsupportedError('window.ethereum.prependOnceListener()') }).bind(windowEthereum),
			_metamask: {
				isUnlocked: (async () => {
					unsupportedError('window.ethereum._metamask.isUnlocked()')
					return this.connected
				}),
				requestBatch: async () => { return unsupportedError('window.ethereum._metamask.requestBatch()') }
			}
		}
	}
	
	private readonly onPageLoad = () => {
		const interceptorMessageListener = this
		function announceProvider() {
			const info: EIP6963ProviderInfo = {
				uuid: '200ecd95-afe4-4684-bce7-0f2f8bdd3498',
				name: 'The Interceptor',
				icon: `data:image/svg+xml,<svg version='1.1' viewBox='0 0 32 32' xml:space='preserve' xmlns='http://www.w3.org/2000/svg'>
					<g>
						<path fill='white' d='m7.95 21.32h0.05c0.03 0 0.06 0 0.08-0.01h0.05c0.03 0 0.06-0.01 0.09-0.01 0.02 0 0.03 0 0.05-0.01 0.03 0 0.06-0.01 0.09-0.01 0.02 0 0.03 0 0.05-0.01 0.03 0 0.07-0.01 0.1-0.02 0.01 0 0.03 0 0.04-0.01 0.04-0.01 0.08-0.01 0.12-0.02h0.02c0.1-0.02 0.19-0.04 0.29-0.07 0.01 0 0.02-0.01 0.03-0.01l0.12-0.03c0.02 0 0.03-0.01 0.05-0.01 0.03-0.01 0.07-0.02 0.1-0.03 0.01 0 0.01 0 0.02-0.01 1.38-0.44 3.08-1.52 5.14-3.68l2.07 1.52 0.79-5.87 3.29-2.67s-12.16-4.99-13.83-5.29c-1.67-0.29-4.29 1.5-5.37 2.67-0.89 0.96 0.07 4.21 0.45 5.37 0.07 0.23 0.32 0.35 0.55 0.27l0.04-0.01c0.17-0.06 0.28-0.22 0.29-0.4 0.01-0.24 0.1-0.48 0.26-0.68l0.18-0.23c0.14-0.17 0.32-0.3 0.52-0.37l2.79-0.98c0.36-0.13 0.76-0.07 1.07 0.16l4.49 3.29c0.32 0.23 0.5 0.61 0.47 1l-0.01 0.1c-0.02 0.31-0.16 0.6-0.39 0.8l-0.01 0.01c-0.09 0.08-0.19 0.17-0.28 0.25l-0.09 0.08c-0.07 0.06-0.13 0.11-0.2 0.17l-0.1 0.08c-0.06 0.06-0.13 0.11-0.19 0.17l-0.08 0.07c-0.09 0.08-0.18 0.15-0.27 0.23l-0.02 0.01c-0.08 0.07-0.16 0.14-0.24 0.2l-0.08 0.07-0.18 0.15-0.08 0.07c-0.06 0.05-0.12 0.1-0.18 0.14l-0.07 0.06c-0.08 0.07-0.16 0.13-0.24 0.19l-0.02 0.02c-0.07 0.06-0.14 0.11-0.21 0.17l-0.07 0.05c-0.05 0.04-0.11 0.08-0.16 0.13l-0.07 0.05c-0.06 0.04-0.11 0.08-0.16 0.13l-0.05 0.04c-0.07 0.06-0.14 0.11-0.21 0.16l-0.03 0.04h-0.01c-0.06 0.05-0.12 0.09-0.18 0.14l-0.06 0.04c-0.05 0.04-0.1 0.07-0.14 0.1l-0.06 0.04c-0.05 0.04-0.1 0.07-0.15 0.11l-0.04 0.03c-0.01 0.01-0.02 0.01-0.03 0.02l-0.01-0.01h0.04l-1.21-1.3c-0.87-1.53 0.65-3.52 1.55-4.5 0.12-0.13 0.1-0.34-0.04-0.45l-1.5-1.1c-0.08-0.06-0.19-0.07-0.28-0.04l-2.56 0.89c-0.05 0.02-0.1 0.05-0.14 0.1-0.08 0.1-0.09 0.23-0.03 0.34l1.3 2.26c0.05 0.09 0.05 0.19 0.01 0.29-0.3 0.61-1.42 2.98-0.8 3.64h-0.02s0.36 0.68 1.14 1.23c0.01 0.01 0.02 0.02 0.04 0.02 0.01 0.01 0.02 0.02 0.04 0.02 0.01 0.01 0.02 0.02 0.04 0.02 0.01 0.01 0.02 0.02 0.04 0.02 0.01 0.01 0.02 0.02 0.04 0.02 0.01 0.01 0.03 0.02 0.04 0.02 0.01 0.01 0.02 0.01 0.04 0.02 0.01 0.01 0.03 0.02 0.04 0.02 0.01 0.01 0.03 0.01 0.04 0.02s0.03 0.02 0.04 0.02c-0.01 0.05 0.01 0.06 0.02 0.07 0.02 0.01 0.03 0.02 0.05 0.02 0.01 0.01 0.02 0.01 0.04 0.02s0.03 0.02 0.05 0.02c0.01 0.01 0.02 0.01 0.04 0.02 0.01 0.01 0.03 0.02 0.05 0.03 0.01 0 0.02 0.01 0.03 0.01 0.03 0.01 0.06 0.03 0.09 0.04 0.01 0 0.01 0 0.02 0.01 0.03 0.01 0.05 0.02 0.08 0.03 0.01 0 0.02 0.01 0.03 0.01 0.02 0.01 0.04 0.02 0.06 0.02 0.01 0 0.03 0.01 0.04 0.01 0.02 0.01 0.04 0.01 0.06 0.02 0.01 0 0.03 0.01 0.04 0.01 0.02 0.01 0.04 0.01 0.06 0.02 0.01 0 0.03 0.01 0.04 0.01 0.02 0.01 0.04 0.01 0.06 0.02 0.01 0 0.03 0.01 0.04 0.01 0.02 0 0.04 0.01 0.07 0.01 0.01 0 0.03 0.01 0.04 0.01 0.02 0 0.05 0.01 0.07 0.01 0.01 0 0.03 0 0.04 0.01 0.03 0 0.05 0.01 0.08 0.01 0.01 0 0.02 0 0.03 0.01 0.03 0 0.06 0.01 0.09 0.01h0.02c0.08 0.01 0.16 0.01 0.24 0.02h0.03 0.09 0.04 0.08 0.04 0.1zm3.9-10.75c0-0.57 0.46-1.03 1.03-1.03s1.03 0.46 1.03 1.03-0.46 1.03-1.03 1.03-1.03-0.46-1.03-1.03z'/>
						<path fill='white' d='m15.29 22.72c-2.88-0.17-4.88-0.79-5.41-0.98l-0.01 0.01-0.33 0.11-0.02 0.01c-0.04 0.01-0.08 0.02-0.12 0.04h-0.01l-0.04 0.01c-0.04 0.01-0.09 0.02-0.13 0.04h-0.01l-0.03 0.01c-0.11 0.03-0.23 0.06-0.34 0.08h-0.02c-0.05 0.01-0.09 0.02-0.14 0.03l-0.04 0.01h-0.01c-0.04 0.01-0.08 0.01-0.12 0.02l-0.04-0.01h-0.01c-0.04 0-0.07 0.01-0.11 0.01h-0.05-0.01c-0.03 0-0.07 0.01-0.1 0.01h-0.06c-0.03 0-0.07 0-0.1 0.01h-0.06-0.06l-0.09 4.4h3.88l0.3-2.38c0.46 0.2 0.91 0.41 1.43 0.48v0.88h-0.01v1.45h3.88l0.06-1.06c0.04-0.35 0.1-0.76 0.15-1.19 1.11-0.11 2.2-0.36 3.26-0.78 0.4 0.96 0.9 2.44 0.9 2.44h4.2l0.13-5.44c-3.46 1.44-6.72 1.83-9.25 1.83-0.52 0-1.01-0.02-1.46-0.04z'/>
						<path fill='white' d='m30.76 14.1c-0.51-1.23-1.69-2.01-2.88-2.67 0.11-0.24 0.18-0.5 0.18-0.78 0-1.04-0.84-1.88-1.88-1.88s-1.88 0.84-1.88 1.88 0.84 1.88 1.88 1.88c0.47 0 0.89-0.19 1.22-0.48 1.02 1.06 2.06 2.52-1.17 4l-0.23-0.63c-0.5 0-1.51 0.5-1.51 0.5l0.34-1c-0.84-0.5-2.01-0.34-2.01-0.34l0.67-0.84c-0.7-0.7-2.32-0.58-2.85-0.52 0.13-0.06 0.33-0.23 0.67-0.65-0.74-0.3-1.32-0.36-1.77-0.3l-1.48 1.2-0.75 5.55-0.19 1.38-0.03 0.2-2.71-1.99c-1.17 1.14-2.3 2.01-3.37 2.6 2.32 0.6 8.4 1.69 15.01-1.19v-0.01c2.66-1.14 5.9-3.12 4.74-5.91zm-11.46 5.51c-0.36-1.49-0.09-3.36 0.67-4.69 0.36 1.49 0.1 3.35-0.67 4.69zm3.02 0c-0.35-0.96-0.08-2.07 0.67-2.76 0.35 0.95 0.08 2.07-0.67 2.76z'/>
					</g>
				</svg>`,
				rdns: 'dark.florist'
			}
			
			if (window.ethereum === undefined || !window.ethereum.isInterceptor) interceptorMessageListener.injectEthereumIntoWindow()
			const provider = window.ethereum
			if (provider === undefined) throw new Error('The Interceptor provider was not initialized')
			window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
		}
		window.addEventListener('eip6963:requestProvider', () => { announceProvider() } )
		announceProvider()
	}

	public readonly injectEthereumIntoWindow = () => {
		if (!('ethereum' in window) || !window.ethereum) {
			// no existing signer found
			window.ethereum = {
				isInterceptor: true,
				isConnected: this.WindowEthereumIsConnected.bind(window.ethereum),
				request: this.WindowEthereumRequest.bind(window.ethereum),
				send: this.WindowEthereumSend.bind(window.ethereum),
				sendAsync: this.WindowEthereumSendAsync.bind(window.ethereum),
				on: this.WindowEthereumOn.bind(window.ethereum),
				removeListener: this.WindowEthereumRemoveListener.bind(window.ethereum),
				enable: this.WindowEthereumEnable.bind(window.ethereum),
				...this.unsupportedMethods(window.ethereum),
			}
			this.connected = true
			this.connectToSigner('NoSigner')
			return
		}
		if (window.ethereum.isInterceptor) return

		// subscribe for signers events
		window.ethereum.on('accountsChanged', (accounts: readonly string[]) => {
			this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts, requestAccounts: false }] })
		})
		window.ethereum.on('connect', (_connectInfo: ProviderConnectInfo) => {

		})
		window.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: [], requestAccounts: false }] })
		})
		window.ethereum.on('chainChanged', (chainId: string) => {
			// TODO: this is a hack to get coinbase working that calls this numbers in base 10 instead of in base 16
			const params = /\d/.test(chainId) ? [`0x${parseInt(chainId).toString(16)}`] : [chainId]
			this.WindowEthereumRequest({ method: 'signer_chainChanged', params })
		})

		this.connected = !window.ethereum.isConnected || window.ethereum.isConnected()
		this.signerWindowEthereumRequest = window.ethereum.request.bind(window.ethereum) // store the request object to signer

		if (window.ethereum.isBraveWallet || window.ethereum.providerMap || window.ethereum.isCoinbaseWallet) {
			const signerName = window.ethereum.providerMap || window.ethereum.isCoinbaseWallet ? 'CoinbaseWallet' : 'Brave'
			const oldWinEthereum = (window.ethereum.providerMap ? window.ethereum.providerMap.get('CoinbaseWallet') : undefined) ?? window.ethereum
			window.ethereum = {
				isInterceptor: true,
				isConnected: this.WindowEthereumIsConnected.bind(oldWinEthereum),
				request: this.WindowEthereumRequest.bind(oldWinEthereum),
				send: this.WindowEthereumSend.bind(oldWinEthereum),
				sendAsync: this.WindowEthereumSendAsync.bind(oldWinEthereum),
				on: this.WindowEthereumOn.bind(oldWinEthereum),
				removeListener: this.WindowEthereumRemoveListener.bind(oldWinEthereum),
				enable: this.WindowEthereumEnable.bind(oldWinEthereum),
				...this.unsupportedMethods(oldWinEthereum),
			}
			this.connectToSigner(signerName)
			return
		}
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		Object.assign(window.ethereum, {
			isInterceptor: true,
			isConnected: this.WindowEthereumIsConnected.bind(window.ethereum),
			request: this.WindowEthereumRequest.bind(window.ethereum),
			send: this.WindowEthereumSend.bind(window.ethereum),
			sendAsync: this.WindowEthereumSendAsync.bind(window.ethereum),
			on: this.WindowEthereumOn.bind(window.ethereum),
			removeListener: this.WindowEthereumRemoveListener.bind(window.ethereum),
			enable: this.WindowEthereumEnable.bind(window.ethereum),
			...this.unsupportedMethods(window.ethereum),
		})
		this.connectToSigner(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
	}
}

function injectInterceptor() {
	const interceptorMessageListener = new InterceptorMessageListener()
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
