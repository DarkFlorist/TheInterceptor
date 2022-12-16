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

interface InterceptedRequestForward {
	readonly interceptorApproved: boolean,
	readonly usingInterceptorWithoutSigner?: boolean,
	readonly requestId?: number,
	options:  {
		readonly method: string,
		readonly params?: unknown[]
	},
	error?: {
		readonly code: number,
		readonly message: string
	}
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
	| ( (accounts: string[]) => void )
	| ( (error: ProviderRpcError) => void )
	| ( (chainId: string) => void )

interface Window {
	dispatchEvent: any,
	ethereum?: {
		request: (options: { readonly method: string, readonly params?: unknown[] }) => Promise<unknown>,
		send: unknown,
		sendAsync: unknown,
		on: (kind: OnMessage, callback: AnyCallBack) => Promise<void>,
		removeListener: (kind: OnMessage, callback: AnyCallBack) => Promise<void>,
		usingInterceptorWithoutSigner?: boolean, // are we using Interceptor as a wallet instead of an external signer
		oldRequest?: (options: { readonly method: string, readonly params?: unknown[] }) => Promise<unknown>,
		oldOn?: (kind: OnMessage, callback: AnyCallBack) => Promise<void>,
		enable: () => void,
		isBraveWallet?: boolean,
		isMetaMask?: boolean,
		isConnected: () => boolean,
	},
	interceptor: {
		interceptorInjected: boolean,
		connected: boolean,
		requestId: number,
		outstandingRequests: Map<number, InterceptorFuture<unknown> >,
		onMessageCallBacks: Set<((message: ProviderMessage) => void)>,
		onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)>
		onAccountsChangedCallBacks: Set<((accounts: string[]) => void)>,
		onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)>,
		onChainChangedCallBacks: Set<((chainId: string) => void)>,
	}
}

window.interceptor = {
	interceptorInjected: false,
	connected: false,
	requestId: 0,
	outstandingRequests: new Map(),
	onMessageCallBacks: new Set(),
	onConnectCallBacks: new Set(),
	onAccountsChangedCallBacks: new Set(),
	onDisconnectCallBacks: new Set(),
	onChainChangedCallBacks: new Set(),
}

type OnMessage = "accountsChanged" | "message" | "connect" | "error" | "close" | "disconnect" | "chainChanged"

function startListeningForMessages() {
	async function requestAccounts() {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || window.ethereum.oldRequest === undefined) return
		const reply = await window.ethereum.oldRequest({method: 'eth_requestAccounts', params: []})

		if ( Array.isArray(reply) ) {
			window.postMessage({
				interceptorRequest: true,
				options: {
					method: 'eth_accounts_reply',
					params: reply,
				},
				usingInterceptorWithoutSigner: window.ethereum.usingInterceptorWithoutSigner,
			}, '*')
		}
	}

	async function requestChainId() {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || window.ethereum.oldRequest === undefined) return
		const reply = await window.ethereum.oldRequest( { method: 'eth_chainId', params: [] } )
		if ( typeof reply === 'string') {
			window.postMessage({
				interceptorRequest: true,
				options: {
					method: 'signer_chainChanged',
					params: [ reply ],
				},
				usingInterceptorWithoutSigner: window.ethereum.usingInterceptorWithoutSigner,
			}, '*')
		}
	}

	function checkErrorForCode(error: unknown): error is { code: number } {
		if (typeof error !== 'object') return false
		if (error === null) return false
		if (!('code' in error)) return false
		if (typeof (error as { code: unknown }).code !== 'number') return false
		return true
	}

	async function requestChangeChain(chainId: string) {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || window.ethereum.oldRequest === undefined) return

		try {
			const reply = await window.ethereum.oldRequest( { method: 'wallet_switchEthereumChain', params: [ { 'chainId': chainId } ] } )
			if ( reply === null) {
				window.postMessage({
					interceptorRequest: true,
					options: {
						method: 'wallet_switchEthereumChain_reply',
						params: [ { accept: true, chainId: chainId } ],
					},
					usingInterceptorWithoutSigner: window.ethereum.usingInterceptorWithoutSigner,
				}, '*')
			}
		} catch (error) {
			if( checkErrorForCode(error) && ( error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK ) ) {
				return window.postMessage({
					interceptorRequest: true,
					options: {
						method: 'wallet_switchEthereumChain_reply',
						params: [ { accept: false, chainId: chainId  } ],
					},
					usingInterceptorWithoutSigner: window.ethereum.usingInterceptorWithoutSigner,
				}, '*')
			}
			throw error
		}
	}

	async function onMessage(messageEvent: any) {
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
			|| !('interceptorApproved' in messageEvent.data)
		) return
		if (!('ethereum' in window) || !window.ethereum) throw 'window.ethereum changed'
		if (!('options' in messageEvent.data || 'method' in messageEvent.data.options || 'params' in messageEvent.data.options)) throw 'missing fields'
		const forwardRequest = messageEvent.data as InterceptedRequestForward //use "as" here as we don't want to inject funtypes here
		if (forwardRequest.error !== undefined) {
			if (forwardRequest.requestId === undefined || !window.interceptor.outstandingRequests.has(forwardRequest.requestId)) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message)
			return window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message))
		}
		if (forwardRequest.result !== undefined) {
			// if interceptor direclty sent us the result, just forward that to the dapp, otherwise ask the signer for the result
			if (forwardRequest.subscription !== undefined) {
				return window.interceptor.onMessageCallBacks.forEach( (f) => f( { type: 'eth_subscription', data: forwardRequest.result } ))
			}
			if (forwardRequest.options.method === 'accountsChanged') {
				return window.interceptor.onAccountsChangedCallBacks.forEach( (f) => f( forwardRequest.result as string[] ) )
			}
			if (forwardRequest.options.method === 'connect') {
				window.interceptor.connected = true
				return window.interceptor.onConnectCallBacks.forEach( (f) => f( { chainId: forwardRequest.result as string } ) )
			}
			if (forwardRequest.options.method === 'disconnect') {
				window.interceptor.connected = false
				const resultArray = forwardRequest.result as { code: number, message: string }
				return window.interceptor.onDisconnectCallBacks.forEach( (f) => f( { name: 'disconnect', ...resultArray } ) )
			}
			if (forwardRequest.options.method === 'chainChanged') {
				return window.interceptor.onChainChangedCallBacks.forEach( (f) => f( forwardRequest.result as string ) )
			}
			if (forwardRequest.options.method === 'request_signer_to_eth_requestAccounts') {
				// when dapp requsts eth_requestAccounts, interceptor needs to reply to it, but we also need to try to sign to the signer
				return await requestAccounts()
			}
			if (forwardRequest.options.method === 'request_signer_to_wallet_switchEthereumChain') {
				return await requestChangeChain( forwardRequest.result as string )
			}
			if (forwardRequest.options.method === 'request_signer_chainId') {
				return await requestChainId()
			}
			if ( forwardRequest.requestId === undefined) return
			return window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.resolve(forwardRequest.result)
		}

		try {
			if ( window.ethereum.usingInterceptorWithoutSigner ) throw 'Interceptor is in wallet mode and should not forward to an external wallet'
			if ( window.ethereum.oldRequest === undefined) throw 'Old provider missing'
			const reply = await window.ethereum.oldRequest(forwardRequest.options)

			if ( forwardRequest.requestId === undefined) return
			window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.resolve(reply)
		} catch (error) {
			// if it is an Error, add context to it if context doesn't already exist
			console.log(error)
			console.log(messageEvent)
			if (forwardRequest.requestId === undefined) throw error
			if (error instanceof Error) {
				if (!('code' in error)) (error as any).code = -32603
				if (!('data' in error) || (error as any).data === undefined || (error as any).data === null) (error as any).data = { request: forwardRequest.options }
				else if (!('request' in (error as any).data)) (error as any).data.request = forwardRequest.options
				return window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.reject(error)
			}
			if ((error as any).code !== undefined && (error as any).message !== undefined) {
				return window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError((error as any).code, (error as any).message, { request: forwardRequest.options }))
			}
			// if the signer we are connected threw something besides an Error, wrap it up in an error
			window.interceptor.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(-32603, `Unexpected thrown value.`, { error: error, request: forwardRequest.options }))
		}
	}
	window.addEventListener('message', onMessage)
}

function injectEthereumIntoWindow() {
	const request = async (options: { readonly method: string, readonly params?: unknown[] }) => {
		window.interceptor.requestId++
		const currentRequestId = window.interceptor.requestId
		const future = new InterceptorFuture<unknown>()
		window.interceptor.outstandingRequests.set(currentRequestId, future)

		try {
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			window.postMessage({
				interceptorRequest: true,
				usingInterceptorWithoutSigner: window.ethereum!.usingInterceptorWithoutSigner,
				requestId: currentRequestId,
				options: {
					method: options.method,
					params: options.params,
				}
			}, '*')
			const reply = await future //TODO: we need to figure out somekind of timeout here, it needs to depend on the request type, eg. if we are asking user to sign something, maybe there shouldn't even be a timeout?
			return reply
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
			window.interceptor.outstandingRequests.delete(currentRequestId)
		}
	}

	// 🤬 Uniswap, among others, require `send` to be implemented even though it was never part of any final specification.
	// To make matters worse, some versions of send will have a first parameter that is an object (like `request`) and others will have a first and second parameter.
	// On top of all that, some applications have a mix of both!
	const send = async (method: string | {method: string, params: unknown[]}, params: unknown[]) => {
		if (typeof method === 'object') {
			return await request({ method: method.method, params: method.params})
		} else {
			return await request({ method, params })
		}
	}

	const sendAsync = async (payload: { id: string | number | null, method: string, params: unknown[] }, callback: (error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void) => {
		request(payload)
			.then(result => callback(null, { jsonrpc: '2.0', id: payload.id, result }))
			// since `request(...)` only throws things shaped like `JsonRpcError`, we can rely on it having those properties.
			.catch(error => callback({ jsonrpc: '2.0', id: payload.id, error: { code: error.code, message: error.message, data: { ...error.data, stack: error.stack } } }, null))
	}

	const on = async (kind: OnMessage, callback: AnyCallBack) => {
		switch (kind) {
			case 'accountsChanged':
				window.interceptor.onAccountsChangedCallBacks.add( callback as (accounts: string[]) => void )
				return
			case 'message':
				window.interceptor.onMessageCallBacks.add(callback as (message: ProviderMessage) => void)
				return
			case 'connect':
				window.interceptor.onConnectCallBacks.add(callback as (connectInfo: ProviderConnectInfo) => void)
				return
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				window.interceptor.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				return
			case 'disconnect':
				window.interceptor.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				return
			case 'chainChanged':
				window.interceptor.onChainChangedCallBacks.add(callback as (chainId: string) => void)
				return
			default:
		}
	}

	const removeListener = async (kind: OnMessage, callback: AnyCallBack) => {
		switch (kind) {
			case 'accountsChanged':
				window.interceptor.onAccountsChangedCallBacks.delete(callback as (accounts: string[]) => void)
				return
			case 'message':
				window.interceptor.onMessageCallBacks.delete(callback as (message: ProviderMessage) => void)
				return
			case 'connect':
				window.interceptor.onConnectCallBacks.delete(callback as (connectInfo: ProviderConnectInfo) => void)
				return
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				window.interceptor.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				return
			case 'disconnect':
				window.interceptor.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				return
			case 'chainChanged':
				window.interceptor.onChainChangedCallBacks.delete(callback as (chainId: string) => void)
				return
			default:
		}
	}

	const isConnected = () => {
		return window.interceptor.connected
	}

	const sendConnectedMessage = (signerName: 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave' ) => {
		if( !('ethereum' in window) || !window.ethereum) return
		window.postMessage({
			interceptorRequest: true,
			options: {
				method: 'connected_to_signer',
				params: [signerName],
			},
			usingInterceptorWithoutSigner: window.ethereum.usingInterceptorWithoutSigner,
		}, '*')
	}

	if(!('ethereum' in window) || !window.ethereum) {
		// no existing signer found
		window.ethereum = {
			request: request,
			on: on,
			removeListener: removeListener,
			send: send,
			sendAsync: sendAsync,
			usingInterceptorWithoutSigner: true,
			enable: () => request({ method: 'eth_requestAccounts' }),
			isConnected: isConnected,
		}
		window.interceptor.interceptorInjected =  true
		startListeningForMessages()
		sendConnectedMessage('NoSigner')
		return
	}
	if('ethereum' in window && 'interceptor' in window.ethereum) {
		return // already injected
	}

	if(window.ethereum.isBraveWallet) {
		window.ethereum = {
			oldRequest: window.ethereum.request, // store the request object to access Brave Wallet later on
			oldOn: window.ethereum.on, // store the on object to access Brave Wallet later on
			request: request,
			on: on,
			removeListener: removeListener,
			send: send,
			sendAsync: sendAsync,
			usingInterceptorWithoutSigner: false,
			enable: () => request({ method: 'eth_requestAccounts' }),
			isConnected: isConnected,
		}
		sendConnectedMessage('Brave')
	} else {
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		window.ethereum.oldRequest = window.ethereum.request // store the request object to access the signer later on
		window.ethereum.oldOn = window.ethereum.on // store the on object to access the signer later on
		window.ethereum.request = request
		window.ethereum.on = on
		window.ethereum.removeListener = removeListener
		window.ethereum.send = send
		window.ethereum.sendAsync = sendAsync
		window.ethereum.usingInterceptorWithoutSigner = false
		window.ethereum.enable = () => request({ method: 'eth_requestAccounts' })
		sendConnectedMessage(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
	}

	if(!window.interceptor.interceptorInjected) {
		startListeningForMessages()
	}
	window.interceptor.interceptorInjected = true

	if (window.ethereum.oldOn) {
		// subscribe for signers events
		window.ethereum.oldOn('accountsChanged', (accounts: string[]) => {
			request( { method: 'eth_accounts_reply', params: accounts } )
		})
		window.ethereum.oldOn('connect', (_connectInfo: ProviderConnectInfo) => {

		})
		window.ethereum.oldOn('disconnect', (_error: ProviderRpcError) => {
			request( { method: 'eth_accounts_reply', params: [] } )
		})
		window.ethereum.oldOn('chainChanged', (chainId: string) => {
			request( { method: 'signer_chainChanged', params: [chainId] } )
		})
	}
}

injectEthereumIntoWindow()
