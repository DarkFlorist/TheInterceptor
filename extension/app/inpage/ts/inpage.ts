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

interface MessageToBackgroundPage {
	readonly interceptorApproved: boolean,
	readonly usingInterceptorWithoutSigner?: boolean,
	readonly requestId?: number,
	options: MessageMethodAndParams,
}

interface InterceptedRequestForward {
	readonly interceptorApproved: boolean,
	readonly usingInterceptorWithoutSigner?: boolean,
	readonly requestId?: number,
	options: MessageMethodAndParams,
	error?: {
		readonly code: number,
		readonly message: string
	}
	readonly result: unknown,
	readonly subscription?: string
}

interface BackgroundPageReplyRequest {
	readonly interceptorApproved: boolean,
	readonly requestId?: number,
	options: MessageMethodAndParams,
	readonly result: unknown,
	readonly subscription?: string
}

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
	| ( (connectInfo: ProviderConnectInfo) => void )
	| ( (accounts: readonly string[]) => void )
	| ( (error: ProviderRpcError) => void )
	| ( (chainId: string) => void )

type EthereumRequest = (options: { readonly method: string, readonly params?: readonly unknown[] }) => Promise<unknown>

type InjectFunctions = {
	request: EthereumRequest
	send: unknown
	sendAsync: unknown
	on: (kind: OnMessage, callback: AnyCallBack) => WindowEthereum
	removeListener: (kind: OnMessage, callback: AnyCallBack) => WindowEthereum
	isConnected: () => boolean
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
	dispatchEvent: any,
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

	// sends messag to The Interceptor background page
	private readonly WindowEthereumRequest = async (options: { readonly method: string, readonly params?: readonly unknown[] }) => {
		this.requestId++
		const currentRequestId = this.requestId
		const future = new InterceptorFuture<unknown>()
		this.outstandingRequests.set(currentRequestId, future)

		try {
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			this.sendMessageToBackgroundPage( { method: options.method, params: options.params }, currentRequestId )
			return await future //TODO: we need to figure out somekind of timeout here, it needs to depend on the request type, eg. if we are asking user to sign something, maybe there shouldn't even be a timeout?
		} catch (error) {
			// if it is an Error, add context to it if context doesn't already exist
			if (error instanceof Error) {
				if (!('code' in error)) (error as any).code = -32603
				if (!('data' in error) || (error as any).data === undefined || (error as any).data === null) (error as any).data = { request: options }
				else if (!('request' in (error as any).data)) (error as any).data.request = options
				throw error
			}
			// if someone threw something besides an Error, wrap it up in an error
			throw new EthereumJsonRpcError(-32603, `Unexpected thrown value.`, { error: error, request: options })
		} finally {
			this.outstandingRequests.delete(currentRequestId)
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
				this.onAccountsChangedCallBacks.add( callback as (accounts: readonly string[]) => void )
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

	private readonly requestAccountsFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined ) return
		const reply = await this.signerWindowEthereumRequest({ method: 'eth_requestAccounts', params: [] })

		if ( !Array.isArray(reply) ) return
		this.sendMessageToBackgroundPage({ method: 'eth_accounts_reply', params: reply })
	}

	private readonly requestChainIdFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined ) return
		const reply = await this.signerWindowEthereumRequest( { method: 'eth_chainId', params: [] } )
		if ( typeof reply !== 'string') return
		this.sendMessageToBackgroundPage({ method: 'signer_chainChanged', params: [ reply ] })
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
			const reply = await this.signerWindowEthereumRequest( { method: 'wallet_switchEthereumChain', params: [ { 'chainId': chainId } ] } )
			if ( reply !== null) return
			this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: true, chainId: chainId } ] })
		} catch (error) {
			if( InterceptorMessageListener.checkErrorForCode(error) && ( error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK ) ) {
				this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: false, chainId: chainId } ] })
			}
			throw error
		}
	}

	private readonly handleReplyRequest = async(replyRequest: BackgroundPageReplyRequest) => {
		if (replyRequest.subscription !== undefined) {
			return this.onMessageCallBacks.forEach( (f) => f( { type: 'eth_subscription', data: replyRequest.result } ))
		}

		// inform callbacks

		if (replyRequest.options.method === 'accountsChanged') {
			return this.onAccountsChangedCallBacks.forEach( (f) => f( replyRequest.result as readonly string[] ) )
		}
		if (replyRequest.options.method === 'connect') {
			this.connected = true
			return this.onConnectCallBacks.forEach( (f) => f( { chainId: replyRequest.result as string } ) )
		}
		if (replyRequest.options.method === 'disconnect') {
			this.connected = false
			const resultArray = replyRequest.result as { code: number, message: string }
			return this.onDisconnectCallBacks.forEach( (f) => f( { name: 'disconnect', ...resultArray } ) )
		}
		if (replyRequest.options.method === 'chainChanged') {
			return this.onChainChangedCallBacks.forEach( (f) => f( replyRequest.result as string ) )
		}

		// The Interceptor requested us to request information from signer

		if (replyRequest.options.method === 'request_signer_to_eth_requestAccounts') {
			// when dapp requsts eth_requestAccounts, interceptor needs to reply to it, but we also need to try to sign to the signer
			return await this.requestAccountsFromSigner()
		}
		if (replyRequest.options.method === 'request_signer_to_wallet_switchEthereumChain') {
			return await this.requestChangeChainFromSigner( replyRequest.result as string )
		}
		if (replyRequest.options.method === 'request_signer_chainId') {
			return await this.requestChainIdFromSigner()
		}

		if ( replyRequest.requestId === undefined) throw new Error('Reply request missing requestId')
		return this.outstandingRequests.get(replyRequest.requestId)!.resolve(replyRequest.result)
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
		if (!('options' in messageEvent.data && typeof messageEvent.data.options === 'object' && messageEvent.data.options !== null)) throw new Error('missing options field')
		if (!('method' in messageEvent.data.options)) throw new Error('missing method field')

		const forwardRequest = messageEvent.data as InterceptedRequestForward //use "as" here as we don't want to inject funtypes here

		if (forwardRequest.error !== undefined) {
			if (forwardRequest.requestId === undefined || !this.outstandingRequests.has(forwardRequest.requestId)) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message)
			return this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message))
		}

		if (forwardRequest.result !== undefined) return this.handleReplyRequest(forwardRequest)

		try {
			if ( this.signerWindowEthereumRequest == undefined) throw 'Interceptor is in wallet mode and should not forward to an external wallet'
			const reply = await this.signerWindowEthereumRequest(forwardRequest.options)

			if ( forwardRequest.requestId === undefined) return
			this.outstandingRequests.get(forwardRequest.requestId)!.resolve(reply)
		} catch (error) {
			// if it is an Error, add context to it if context doesn't already exist
			console.log(error)
			console.log(messageEvent)
			if (forwardRequest.requestId === undefined) throw error
			if (error instanceof Error) {
				if (!('code' in error)) (error as any).code = -32603
				if (!('data' in error) || (error as any).data === undefined || (error as any).data === null) (error as any).data = { request: forwardRequest.options }
				else if (!('request' in (error as any).data)) (error as any).data.request = forwardRequest.options
				return this.outstandingRequests.get(forwardRequest.requestId)!.reject(error)
			}
			if ((error as any).code !== undefined && (error as any).message !== undefined) {
				return this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError((error as any).code, (error as any).message, { request: forwardRequest.options }))
			}
			// if the signer we are connected threw something besides an Error, wrap it up in an error
			this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(-32603, `Unexpected thrown value.`, { error: error, request: forwardRequest.options }))
		}
	}

	private readonly sendMessageToBackgroundPage = (messageMethodAndParams: MessageMethodAndParams, requestId: number | undefined = undefined) => {
		window.postMessage({
			interceptorRequest: true,
			options: {
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
			},
			usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
			...(requestId === undefined ? { } : { requestId: requestId })
		}, '*')
	}

	private readonly sendConnectedMessage = (signerName: 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave') => {
		this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [signerName] })
	}

	private readonly injectUnsupportedMethods = (windowEthereum: WindowEthereum & UnsupportedWindowEthereumMethods) => {
		const unsupportedError = (method: string) => {
			return console.error(`The application tried to call a deprecated or non-standard method: "${ method }". Please contact the application developer to fix this issue.`)
		}

		windowEthereum.once = () => { return unsupportedError('window.ethereum.once()') },
		windowEthereum.prependListener = () => { return unsupportedError('window.ethereum.prependListener()') },
		windowEthereum.prependOnceListener = () => { return unsupportedError('window.ethereum.prependOnceListener()') },
		windowEthereum._metamask = {
			isUnlocked: async () => {
				unsupportedError('window.ethereum._metamask.isUnlocked()')
				return this.connected
			},
			requestBatch: async () => { return unsupportedError('window.ethereum._metamask.requestBatch()') }
		}
	}

	public readonly injectEthereumIntoWindow = () => {
		if (!('ethereum' in window) || !window.ethereum) {
			// no existing signer found

			window.ethereum = {
				isConnected: this.WindowEthereumIsConnected,
				request: this.WindowEthereumRequest,
				send: this.WindowEthereumSend,
				sendAsync: this.WindowEthereumSendAsync,
				on: this.WindowEthereumOn,
				removeListener: this.WindowEthereumRemoveListener,
				enable: this.WindowEthereumEnable,
			}
			this.injectUnsupportedMethods(window.ethereum)
			this.connected = true

			return this.sendConnectedMessage('NoSigner')
		}

		// subscribe for signers events
		window.ethereum.on('accountsChanged', (accounts: readonly string[]) => {
			this.WindowEthereumRequest( { method: 'eth_accounts_reply', params: accounts } )
		})
		window.ethereum.on('connect', (_connectInfo: ProviderConnectInfo) => {

		})
		window.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			this.WindowEthereumRequest( { method: 'eth_accounts_reply', params: [] } )
		})
		window.ethereum.on('chainChanged', (chainId: string) => {
			this.WindowEthereumRequest( { method: 'signer_chainChanged', params: [chainId] } )
		})

		this.connected = window.ethereum.isConnected()
		this.signerWindowEthereumRequest = window.ethereum.request // store the request object to signer

		if (window.ethereum.isBraveWallet) {
			window.ethereum = {
				isConnected: this.WindowEthereumIsConnected,
				request: this.WindowEthereumRequest,
				send: this.WindowEthereumSend,
				sendAsync: this.WindowEthereumSendAsync,
				on: this.WindowEthereumOn,
				removeListener: this.WindowEthereumRemoveListener,
				enable: this.WindowEthereumEnable
			}
			this.injectUnsupportedMethods(window.ethereum)
			return this.sendConnectedMessage('Brave')
		}
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		window.ethereum.isConnected = this.WindowEthereumIsConnected
		window.ethereum.request = this.WindowEthereumRequest
		window.ethereum.send = this.WindowEthereumSend
		window.ethereum.sendAsync = this.WindowEthereumSendAsync
		window.ethereum.on = this.WindowEthereumOn
		window.ethereum.removeListener = this.WindowEthereumRemoveListener
		window.ethereum.enable = this.WindowEthereumEnable
		this.injectUnsupportedMethods(window.ethereum)
		this.sendConnectedMessage(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
	}
}

function injectInterceptor() {
	const interceptorMessageListener = new InterceptorMessageListener()
	window.addEventListener('message', interceptorMessageListener.onMessage)

	// listen if Metamask injects their payload, and if so, reinject Interceptor
	const interceptorCapturedDispatcher = window.dispatchEvent
	window.dispatchEvent = (event: unknown) => {
		interceptorCapturedDispatcher(event)
		if ( !(typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string')) return
		if (event.type !== 'ethereum#initialized') return
		interceptorMessageListener.injectEthereumIntoWindow()
		window.dispatchEvent = interceptorCapturedDispatcher
	}
}

injectInterceptor()
