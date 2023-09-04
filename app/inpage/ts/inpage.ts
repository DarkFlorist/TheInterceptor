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

	public readonly resolve = (value: T | PromiseLike<T>) => {
		this.resolveFunction!(value)
	}

	public readonly reject = (reason: Error) => {
		this.rejectFunction!(reason)
	}
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
	readonly result: unknown,
}

type InterceptedRequestForward = InterceptedRequestBase & ({ error?: {
	readonly code: number,
	readonly message: string,
	readonly data?: object
} } | {
	readonly result: unknown,
} | {} )

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
	providerMap?: unknown, // coinbase does not inject `isCoinbaseWallet` to the window.ethereum if there's already other wallets present (eg, Interceptor or Metamask), but instead injects a provider map that contains all these providers
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

	public constructor() {
		this.injectEthereumIntoWindow()
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

	private readonly WindowEthereumSend = (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[], _params: readonly unknown[] }) => {
		console.warn('A deprecated method window.ethereum.send called')
		if (this.metamaskCompatibilityMode) {
			if (window.ethereum === undefined) throw new Error('window.ethereum is missing')
			switch (payload.method) {
				case 'eth_coinbase': 
				case 'eth_accounts': return { jsonrpc: '2.0', id: payload.id, result: window.ethereum.selectedAddress === undefined || window.ethereum.selectedAddress === null ? [] : [window.ethereum.selectedAddress] }
				case 'net_version': return { jsonrpc: '2.0', id: payload.id, result: window.ethereum.networkVersion }
				case 'eth_chainId': return { jsonrpc: '2.0', id: payload.id, result: window.ethereum.chainId }
				default: throw new EthereumJsonRpcError(METAMASK_INVALID_METHOD_PARAMS, `Invalid method parameter for window.ethereum.send: ${ payload.method }`)
			}
		}
		throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, 'Method not supported (window.ethereum.send).')
	}

	private readonly WindowEthereumSendAsync = async (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] }, callback: (error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void) => {
		this.WindowEthereumRequest(payload)
			.then(result => callback(null, { jsonrpc: '2.0', id: payload.id, result }))
			// since `request(...)` only throws things shaped like `JsonRpcError`, we can rely on it having those properties.
			.catch(error => callback({ jsonrpc: '2.0', id: payload.id, error: { code: error.code, message: error.message, data: { ...error.data, stack: error.stack } } }, null))
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

	private readonly requestAccountsFromSigner = async (ask_eth_requestAccounts: boolean) => {
		if (this.signerWindowEthereumRequest === undefined) return
		const reply = await this.signerWindowEthereumRequest({ method: ask_eth_requestAccounts ? 'eth_requestAccounts' : 'eth_accounts', params: [] })
		if (!Array.isArray(reply)) return
		await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [reply, ask_eth_requestAccounts] })
		if (this.waitForAccountsFromWallet !== undefined) {
			this.waitForAccountsFromWallet.resolve(true)
			this.waitForAccountsFromWallet = undefined
		}
	}

	private readonly requestChainIdFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		const reply = await this.signerWindowEthereumRequest({ method: 'eth_chainId', params: [] })
		if (typeof reply !== 'string') return
		return await this.sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [ reply ] })
	}

	private static readonly checkErrorForCode = (error: unknown): error is { code: number } => {
		if (typeof error !== 'object') return false
		if (error === null) return false
		if (!('code' in error)) return false
		if (typeof (error as { code: unknown }).code !== 'number') return false
		return true
	}

	private readonly requestChangeChainFromSigner = async (chainId: string) => {
		if (this.signerWindowEthereumRequest === undefined) return

		try {
			const reply = await this.signerWindowEthereumRequest({ method: 'wallet_switchEthereumChain', params: [ { 'chainId': chainId } ] })
			if (reply !== null) return
			await this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: true, chainId: chainId } ] })
		} catch (error: unknown) {
			if (InterceptorMessageListener.checkErrorForCode(error) && ( error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
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
					if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && window.ethereum !== undefined) {
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
				case 'request_signer_to_eth_requestAccounts': return await this.requestAccountsFromSigner(true)
				case 'request_signer_to_eth_accounts':  return await this.requestAccountsFromSigner(false)
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
		const forwardRequest = messageEvent.data as InterceptedRequestForward //use 'as' here as we don't want to inject funtypes here
		if ('error' in forwardRequest && forwardRequest.error !== undefined) {
			if (forwardRequest.requestId === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
			const pending = this.outstandingRequests.get(forwardRequest.requestId)
			if (pending === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
			return pending.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data))
		}
		if ('result' in forwardRequest && forwardRequest.result !== undefined) {
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
					}
					default:
				}
			}
			return await this.handleReplyRequest(forwardRequest)
		}

		try {
			if (this.signerWindowEthereumRequest == undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
			const reply = await this.signerWindowEthereumRequest({
				method: forwardRequest.method,
				params: 'params' in forwardRequest ? forwardRequest.params : []
			})
			if (forwardRequest.requestId !== undefined) {
				const pendingRequest = this.outstandingRequests.get(forwardRequest.requestId)
				if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
				pendingRequest.resolve(reply)
			}
		} catch (error: unknown) {
			if (forwardRequest.requestId === undefined) return
			const pendingRequest = this.outstandingRequests.get(forwardRequest.requestId)
			if (pendingRequest === undefined) throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, `Unexpected thrown value and request was not found anymore`, { error: error }) 
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
			await this.requestAccountsFromSigner(false)
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

		// subscribe for signers events
		window.ethereum.on('accountsChanged', (accounts: readonly string[]) => {
			this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: [accounts, false] })
		})
		window.ethereum.on('connect', (_connectInfo: ProviderConnectInfo) => {

		})
		window.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			this.WindowEthereumRequest({ method: 'eth_accounts_reply', params: [[], false] })
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
