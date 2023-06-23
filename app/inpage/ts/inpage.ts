const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
const METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK = 4902

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
	readonly message: string
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
}
interface Window {
	dispatchEvent: (event: Event) => boolean
	ethereum?: WindowEthereum
}

type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'

class InterceptorMessageListener {
	private connected: boolean = false
	private requestId: number = 0
	private signerWindowEthereumRequest: EthereumRequest | undefined = undefined

	private readonly outstandingRequests: Map<number, InterceptorFuture<unknown> > = new Map()

	private readonly onMessageCallBacks: Set<((message: ProviderMessage) => void)> = new Set()
	private readonly onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)> = new Set()
	private readonly onAccountsChangedCallBacks: Set<((accounts: readonly string[]) => void)> = new Set()
	private readonly onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)> = new Set()
	private readonly onChainChangedCallBacks: Set<((chainId: string) => void)> = new Set()

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
		} catch (error: unknown) {
			throw error
		} finally {
			this.outstandingRequests.delete(pendingRequestId)
		}
	}

	// sends messag to The Interceptor background page
	private readonly WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }) => {
		try {
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			return await this.sendMessageToBackgroundPage({ method: methodAndParams.method, params: methodAndParams.params })
		} catch (error: unknown) {
			// if it is an Error, add context to it if context doesn't already exist
			if (error instanceof Error) {
				throw {
					...error,
					code: ('code' in error && typeof error.code !== 'number') ? error.code : -32603,
					data: !('data' in error) || error.data === undefined || error.data === null || typeof error.data !== 'object' ? { request: methodAndParams } : { ...error.data, request: methodAndParams }
				}
			}
			// if someone threw something besides an Error, wrap it up in an error
			throw new EthereumJsonRpcError(-32603, `Unexpected thrown value.`, { error: error, request: methodAndParams })
		}
	}

	// 🤬 Uniswap, among others, require `send` to be implemented even though it was never part of any final specification.
	// To make matters worse, some versions of send will have a first parameter that is an object (like `request`) and others will have a first and second parameter.
	// On top of all that, some applications have a mix of both!
	private readonly WindowEthereumSend = async (method: string | { readonly method: string, readonly params: readonly unknown[] }, params: readonly unknown[]) => {
		if (typeof method === 'object') return await this.WindowEthereumRequest({ method: method.method, params: method.params })
		return await this.WindowEthereumRequest({ method, params })
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
		return await this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [reply, ask_eth_requestAccounts]  })
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
				case 'accountsChanged': return this.onAccountsChangedCallBacks.forEach((callback) => callback(replyRequest.result as readonly string[]))
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
				case 'chainChanged': return this.onChainChangedCallBacks.forEach((callback) => callback(replyRequest.result as string))
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

	public readonly onMessage = async (messageEvent: unknown) => {
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
		const forwardRequest = messageEvent.data as InterceptedRequestForward //use "as" here as we don't want to inject funtypes here
		if ('error' in forwardRequest && forwardRequest.error !== undefined) {
			if (forwardRequest.requestId === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message)
			const pending = this.outstandingRequests.get(forwardRequest.requestId)
			if (pending === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message)
			return pending.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, { request: forwardRequest }))
		}

		if ('result' in forwardRequest && forwardRequest.result !== undefined) return await this.handleReplyRequest(forwardRequest)

		try {
			if (this.signerWindowEthereumRequest == undefined) throw 'Interceptor is in wallet mode and should not forward to an external wallet'
			const reply = await this.signerWindowEthereumRequest(forwardRequest)
			if (forwardRequest.requestId !== undefined) this.outstandingRequests.get(forwardRequest.requestId)!.resolve(reply)
		} catch (error: unknown) {
			// if it is an Error, add context to it if context doesn't already exist
			console.log(error)
			console.log(messageEvent)
			if (forwardRequest.requestId === undefined) return
			if (error instanceof Error) {
				const inputedErrorObject = {
					...error,
					code: ('code' in error && typeof error.code !== 'number') ? error.code : -32603,
					data: !('data' in error) || error.data === undefined || error.data === null || typeof error.data !== 'object' ? { request: forwardRequest } : { ...error.data, request: forwardRequest }
				}
				return this.outstandingRequests.get(forwardRequest.requestId)!.reject(inputedErrorObject)
			}
			if (typeof error === 'object' && error !== null
				&& 'code' in error && error.code !== undefined && typeof error.code === 'number'
				&& 'message' in error && error.message !== undefined && typeof error.message === 'string'
			) {
				return this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(error.code, error.message, { request: forwardRequest }))
			}
			// if the signer we are connected threw something besides an Error, wrap it up in an error
			this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(-32603, `Unexpected thrown value.`, { error: error, request: forwardRequest }))
		}
	}

	private readonly sendConnectedMessage = async (signerName: 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave') => {
		return await this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [signerName] })
	}

	private readonly unsupportedMethods = (windowEthereum: WindowEthereum & UnsupportedWindowEthereumMethods | undefined) => {
		const unsupportedError = (method: string) => {
			return console.error(`The application tried to call a deprecated or non-standard method: "${ method }". Please contact the application developer to fix this issue.`)
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
			this.sendConnectedMessage('NoSigner')
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
			this.WindowEthereumRequest({ method: 'signer_chainChanged', params: [chainId] })
		})

		this.connected = !window.ethereum.isConnected || window.ethereum.isConnected()
		this.signerWindowEthereumRequest = window.ethereum.request.bind(window.ethereum) // store the request object to signer

		if (window.ethereum.isBraveWallet) {
			window.ethereum = {
				isConnected: this.WindowEthereumIsConnected.bind(window.ethereum),
				request: this.WindowEthereumRequest.bind(window.ethereum),
				send: this.WindowEthereumSend.bind(window.ethereum),
				sendAsync: this.WindowEthereumSendAsync.bind(window.ethereum),
				on: this.WindowEthereumOn.bind(window.ethereum),
				removeListener: this.WindowEthereumRemoveListener.bind(window.ethereum),
				enable: this.WindowEthereumEnable.bind(window.ethereum),
				...this.unsupportedMethods(window.ethereum),
			}
			this.sendConnectedMessage('Brave')
			return
		}
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		Object.assign(window.ethereum, {
			isConnected: this.WindowEthereumIsConnected.bind(window.ethereum),
			request: this.WindowEthereumRequest.bind(window.ethereum),
			send: this.WindowEthereumSend.bind(window.ethereum),
			sendAsync: this.WindowEthereumSendAsync.bind(window.ethereum),
			on: this.WindowEthereumOn.bind(window.ethereum),
			removeListener: this.WindowEthereumRemoveListener.bind(window.ethereum),
			enable: this.WindowEthereumEnable.bind(window.ethereum),
			...this.unsupportedMethods(window.ethereum),
		})
		this.sendConnectedMessage(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
	}
}

function injectInterceptor() {
	const interceptorMessageListener = new InterceptorMessageListener()
	window.addEventListener('message', interceptorMessageListener.onMessage)

	// listen if Metamask injects their payload, and if so, reinject Interceptor
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
