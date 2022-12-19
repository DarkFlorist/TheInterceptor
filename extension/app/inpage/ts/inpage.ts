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

type EthereumRequest = (options: { readonly method: string, readonly params?: unknown[] }) => Promise<unknown>

type InjectFunctions = {
	request: EthereumRequest,
	send: unknown,
	sendAsync: unknown,
	on: (kind: OnMessage, callback: AnyCallBack) => Promise<void>,
	removeListener: (kind: OnMessage, callback: AnyCallBack) => Promise<void>,
	isConnected: () => boolean,
	enable: () => void,
}

type WindowEthereum = InjectFunctions & {
	isBraveWallet?: boolean,
	isMetaMask?: boolean,
}

interface Window {
	dispatchEvent: any,
	ethereum?: WindowEthereum
}

type OnMessage = "accountsChanged" | "message" | "connect" | "error" | "close" | "disconnect" | "chainChanged"

function checkErrorForCode(error: unknown): error is { code: number } {
	if (typeof error !== 'object') return false
	if (error === null) return false
	if (!('code' in error)) return false
	if (typeof (error as { code: unknown }).code !== 'number') return false
	return true
}
class InterceptorMessageListener {
	private connected: boolean = false
	private requestId: number = 0
	private signerRequest: EthereumRequest | undefined
	private usingInterceptorWithoutSigner: boolean = true
	private readonly outstandingRequests: Map<number, InterceptorFuture<unknown> > = new Map()
	private readonly onMessageCallBacks: Set<((message: ProviderMessage) => void)> = new Set()
	private readonly onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)> = new Set()
	private readonly onAccountsChangedCallBacks: Set<((accounts: string[]) => void)> = new Set()
	private readonly onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)> = new Set()
	private readonly onChainChangedCallBacks: Set<((chainId: string) => void)> = new Set()

	public constructor() {
		this.injectEthereumIntoWindow()

		const interceptorCapturedDispatcher = window.dispatchEvent
		window.dispatchEvent = (event: any) => {
			interceptorCapturedDispatcher(event)
			if (event.type === 'ethereum#initialized') {
				console.log('Interceptor: Detected MetaMask reinject')
				this.injectEthereumIntoWindow()
				window.dispatchEvent = interceptorCapturedDispatcher
			}
		}
		console.log('start listening...')
		window.addEventListener('message', this.onMessage)
	}

	private isConnected = () => {
		return this.connected
	}

	// sends messag to The Interceptor background page
	private request = async (options: { readonly method: string, readonly params?: unknown[] }) => {
		this.requestId++
		const currentRequestId = this.requestId
		const future = new InterceptorFuture<unknown>()
		this.outstandingRequests.set(currentRequestId, future)
		console.log(`request: ${currentRequestId}: ${options.method}`)

		try {
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			window.postMessage({
				interceptorRequest: true,
				usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
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
			console.log(`delete request: ${currentRequestId}: ${options.method}`)
			this.outstandingRequests.delete(currentRequestId)
		}
	}

	// 🤬 Uniswap, among others, require `send` to be implemented even though it was never part of any final specification.
	// To make matters worse, some versions of send will have a first parameter that is an object (like `request`) and others will have a first and second parameter.
	// On top of all that, some applications have a mix of both!
	private send = async (method: string | {method: string, params: unknown[]}, params: unknown[]) => {
		if (typeof method === 'object') {
			return await this.request({ method: method.method, params: method.params})
		} else {
			return await this.request({ method, params })
		}
	}

	private sendAsync = async (payload: { id: string | number | null, method: string, params: unknown[] }, callback: (error: IJsonRpcError | null, response: IJsonRpcSuccess<unknown> | null) => void) => {
		this.request(payload)
			.then(result => callback(null, { jsonrpc: '2.0', id: payload.id, result }))
			// since `request(...)` only throws things shaped like `JsonRpcError`, we can rely on it having those properties.
			.catch(error => callback({ jsonrpc: '2.0', id: payload.id, error: { code: error.code, message: error.message, data: { ...error.data, stack: error.stack } } }, null))
	}

	private on = async (kind: OnMessage, callback: AnyCallBack) => {
		switch (kind) {
			case 'accountsChanged':
				this.onAccountsChangedCallBacks.add( callback as (accounts: string[]) => void )
				return
			case 'message':
				this.onMessageCallBacks.add(callback as (message: ProviderMessage) => void)
				return
			case 'connect':
				this.onConnectCallBacks.add(callback as (connectInfo: ProviderConnectInfo) => void)
				return
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				this.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				return
			case 'disconnect':
				this.onDisconnectCallBacks.add(callback as (error: ProviderRpcError) => void)
				return
			case 'chainChanged':
				this.onChainChangedCallBacks.add(callback as (chainId: string) => void)
				return
			default:
		}
	}

	private removeListener = async (kind: OnMessage, callback: AnyCallBack) => {
		switch (kind) {
			case 'accountsChanged':
				this.onAccountsChangedCallBacks.delete(callback as (accounts: string[]) => void)
				return
			case 'message':
				this.onMessageCallBacks.delete(callback as (message: ProviderMessage) => void)
				return
			case 'connect':
				this.onConnectCallBacks.delete(callback as (connectInfo: ProviderConnectInfo) => void)
				return
			case 'close': //close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				this.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				return
			case 'disconnect':
				this.onDisconnectCallBacks.delete(callback as (error: ProviderRpcError) => void)
				return
			case 'chainChanged':
				this.onChainChangedCallBacks.delete(callback as (chainId: string) => void)
				return
			default:
		}
	}

	private enable = async () => {
		this.request({ method: 'eth_requestAccounts' })
	}

	// listens for Interceptor, DApps, and signers messaes
	private async requestAccounts() {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || this.signerRequest === undefined ) return
		const reply = await this.signerRequest({ method: 'eth_requestAccounts', params: [] })

		if ( Array.isArray(reply) ) {
			window.postMessage({
				interceptorRequest: true,
				options: {
					method: 'eth_accounts_reply',
					params: reply,
				},
				usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
			}, '*')
		}
	}

	private async requestChainId() {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || this.signerRequest === undefined ) return
		const reply = await this.signerRequest( { method: 'eth_chainId', params: [] } )
		if ( typeof reply === 'string') {
			window.postMessage({
				interceptorRequest: true,
				options: {
					method: 'signer_chainChanged',
					params: [ reply ],
				},
				usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
			}, '*')
		}
	}

	private async requestChangeChain(chainId: string) {
		if( !('ethereum' in window) || !window.ethereum || !('oldRequest' in window.ethereum) || this.signerRequest === undefined) return

		try {
			const reply = await this.signerRequest( { method: 'wallet_switchEthereumChain', params: [ { 'chainId': chainId } ] } )
			if ( reply === null) {
				window.postMessage({
					interceptorRequest: true,
					options: {
						method: 'wallet_switchEthereumChain_reply',
						params: [ { accept: true, chainId: chainId } ],
					},
					usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
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
					usingInterceptorWithoutSigner: this.usingInterceptorWithoutSigner,
				}, '*')
			}
			throw error
		}
	}

	private async onMessage(messageEvent: any) {
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
		console.log(`reply: ${forwardRequest.requestId}: ${forwardRequest.options.method}`)
		console.log(this.outstandingRequests.keys())
		if (forwardRequest.error !== undefined) {
			if (forwardRequest.requestId === undefined || !this.outstandingRequests.has(forwardRequest.requestId)) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message)
			return this.outstandingRequests.get(forwardRequest.requestId)!.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message))
		}
		if (forwardRequest.result !== undefined) {
			// if interceptor direclty sent us the result, just forward that to the dapp, otherwise ask the signer for the result
			if (forwardRequest.subscription !== undefined) {
				return this.onMessageCallBacks.forEach( (f) => f( { type: 'eth_subscription', data: forwardRequest.result } ))
			}
			if (forwardRequest.options.method === 'accountsChanged') {
				return this.onAccountsChangedCallBacks.forEach( (f) => f( forwardRequest.result as string[] ) )
			}
			if (forwardRequest.options.method === 'connect') {
				this.connected = true
				return this.onConnectCallBacks.forEach( (f) => f( { chainId: forwardRequest.result as string } ) )
			}
			if (forwardRequest.options.method === 'disconnect') {
				this.connected = false
				const resultArray = forwardRequest.result as { code: number, message: string }
				return this.onDisconnectCallBacks.forEach( (f) => f( { name: 'disconnect', ...resultArray } ) )
			}
			if (forwardRequest.options.method === 'chainChanged') {
				return this.onChainChangedCallBacks.forEach( (f) => f( forwardRequest.result as string ) )
			}
			if (forwardRequest.options.method === 'request_signer_to_eth_requestAccounts') {
				// when dapp requsts eth_requestAccounts, interceptor needs to reply to it, but we also need to try to sign to the signer
				return await this.requestAccounts()
			}
			if (forwardRequest.options.method === 'request_signer_to_wallet_switchEthereumChain') {
				return await this.requestChangeChain( forwardRequest.result as string )
			}
			if (forwardRequest.options.method === 'request_signer_chainId') {
				return await this.requestChainId()
			}
			if ( forwardRequest.requestId === undefined) return
			return this.outstandingRequests.get(forwardRequest.requestId)!.resolve(forwardRequest.result)
		}

		try {
			if ( this.usingInterceptorWithoutSigner ) throw 'Interceptor is in wallet mode and should not forward to an external wallet'
			if ( this.signerRequest == undefined) throw 'signer not found'
			console.log('signer request')
			const reply = await this.signerRequest(forwardRequest.options)

			if ( forwardRequest.requestId === undefined) return
			this.outstandingRequests.get(forwardRequest.requestId)!.resolve(reply)
			console.log(`resolved: ${forwardRequest.requestId}: ${forwardRequest.options.method}`)
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

	private sendConnectedMessage = (signerName: 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave') => {
		if( !('ethereum' in window) || !window.ethereum) return
		window.postMessage({
			interceptorRequest: true,
			options: {
				method: 'connected_to_signer',
				params: [signerName],
			},
			usingInterceptorWithoutSigner: signerName === 'NoSigner',
		}, '*')
	}

	public injectEthereumIntoWindow() {
		if (!('ethereum' in window) || !window.ethereum) {

			console.log('no signer')
			// no existing signer found

			window.ethereum = {
				isConnected: this.isConnected,
				request: this.request,
				send: this.send,
				sendAsync: this.sendAsync,
				on: this.on,
				removeListener: this.removeListener,
				enable: this.enable
			}
			this.usingInterceptorWithoutSigner = true

			return this.sendConnectedMessage('NoSigner')
		}

		console.log('injecting on top of existing')

		this.signerRequest = window.ethereum.request // store the request object to signer

		// subscribe for signers events
		window.ethereum.on('accountsChanged', (accounts: string[]) => {
			this.request( { method: 'eth_accounts_reply', params: accounts } )
		})
		window.ethereum.on('connect', (_connectInfo: ProviderConnectInfo) => {

		})
		window.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			this.request( { method: 'eth_accounts_reply', params: [] } )
		})
		window.ethereum.on('chainChanged', (chainId: string) => {
			this.request( { method: 'signer_chainChanged', params: [chainId] } )
		})

		if (window.ethereum.isBraveWallet) {
			window.ethereum = {
				isConnected: this.isConnected,
				request: this.request,
				send: this.send,
				sendAsync: this.sendAsync,
				on: this.on,
				removeListener: this.removeListener,
				enable: this.enable
			}
			this.sendConnectedMessage('Brave')
		} else {
			// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
			window.ethereum.request = this.request
			window.ethereum.on = this.on
			window.ethereum.removeListener = this.removeListener
			window.ethereum.send = this.send
			window.ethereum.sendAsync = this.sendAsync
			window.ethereum.enable = this.enable
			this.sendConnectedMessage(window.ethereum.isMetaMask ? 'MetaMask' : 'NotRecognizedSigner')
		}

		this.usingInterceptorWithoutSigner = false
	}

}

new InterceptorMessageListener()
