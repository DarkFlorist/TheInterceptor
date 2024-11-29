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
type Signer = 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave' | 'CoinbaseWallet'

class InterceptorMessageListener {
	private connected = false
	private requestId = 0
	private metamaskCompatibilityMode = false
	private signerWindowEthereumRequest: EthereumRequest | undefined = undefined

	private readonly outstandingRequests: Map<number, InterceptorFuture<unknown> > = new Map()

	private readonly onMessageCallBacks: Set<((message: ProviderMessage) => void)> = new Set()
	private readonly onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)> = new Set()
	private readonly onAccountsChangedCallBacks: Set<((accounts: readonly string[]) => void)> = new Set()
	private readonly onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)> = new Set()
	private readonly onChainChangedCallBacks: Set<((chainId: string) => void)> = new Set()

	private currentAddress = ''
	private activeChainId = ''
	private currentSigner: Signer = 'NoSigner'

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
		} catch(error) {
			throw error
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
			throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { error: error, request: methodAndParams })
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
			const reply = await this.signerWindowEthereumRequest({ method: 'wallet_switchEthereumChain', params: [ { chainId } ] })
			if (reply !== null) return
			await this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: true, chainId: chainId } ] })
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error) && (error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
				await this.sendMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: false, chainId: chainId, error } ] })
			}
			throw error
		}
	}

	private readonly handleReplyRequest = async(replyRequest: InterceptedRequestForwardWithResult) => {
		try {
			if (replyRequest.subscription !== undefined) {
				for (const callback of this.onMessageCallBacks) {
					callback({ type: 'eth_subscription', data: replyRequest.result })
				}
				return
			}
			// inform callbacks
			switch (replyRequest.method) {
				case 'accountsChanged': {
					const reply = replyRequest.result as readonly string[]
					const replyAddress = reply.length > 0 ? reply[0] : ''
					if (this.currentAddress === replyAddress) return
					this.currentAddress = replyAddress
					if (this.metamaskCompatibilityMode && window.ethereum !== undefined) {
						try { window.ethereum.selectedAddress = replyAddress } catch(error) {}
						if ('web3' in window && window.web3 !== undefined) try { window.web3.accounts = reply } catch(error) {}
					}
					for (const callback of this.onAccountsChangedCallBacks) {
						callback(reply)
					}
					return
				}
				case 'connect': {
					if (this.connected) return
					this.connected = true
					for (const callback of this.onConnectCallBacks) {
						callback({ chainId: replyRequest.result as string })
					}
					return
				}
				case 'disconnect': {
					if (!this.connected) return
					this.connected = false
					for (const callback of this.onDisconnectCallBacks) {
						callback({ name: 'disconnect', code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User refused access to the wallet' })
					}
					return
				}
				case 'chainChanged': {
					const reply = replyRequest.result as string
					if (this.activeChainId === reply) return
					this.activeChainId = reply
					if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && window.ethereum !== undefined) {
						try { window.ethereum.chainId = reply } catch(error) {}
						try { window.ethereum.networkVersion = Number(reply).toString(10) } catch(error) {}
					}
					for (const callback of this.onChainChangedCallBacks) {
						callback(reply)
					}
					return
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

	private parseRpcError = (maybeErrorObject: unknown) => {
		if (typeof maybeErrorObject !== 'object' || maybeErrorObject === null) return new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { rawError: maybeErrorObject } )
		if ('code' in maybeErrorObject
			&& maybeErrorObject.code !== undefined && typeof maybeErrorObject.code === 'number'
			&& 'message' in maybeErrorObject && maybeErrorObject.message !== undefined && typeof maybeErrorObject.message === 'string'
		) {
			return new EthereumJsonRpcError(maybeErrorObject.code, maybeErrorObject.message, 'data' in maybeErrorObject && typeof maybeErrorObject.data === 'object' && maybeErrorObject.data !== null ? maybeErrorObject.data : undefined)
		}
		return new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', maybeErrorObject )
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
		try {
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
							const addr = addrArray.length > 0 ? addrArray[0] : ''
							try { window.ethereum.selectedAddress = addr } catch(e) {}
							if ('web3' in window && window.web3 !== undefined) try { window.web3.accounts = addrArray } catch(e) {}
							this.currentAddress = addr
							break
						}
						case 'eth_chainId': {
							if (typeof forwardRequest.result !== 'string') throw new Error('wrong type')
							const chainId = forwardRequest.result as string
							try { window.ethereum.chainId = chainId } catch(e) {}
							try { window.ethereum.networkVersion = Number(chainId).toString(10) } catch(e) {}
							this.activeChainId = chainId
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
					return { success: true as const, forwardRequest, reply }
				} catch(error: unknown) {
					return { success: false as const, forwardRequest, error }
				}
			}
			const signerReply = await sendToSignerWithCatchError()
			try {
				if ('replyWithSignersReply' in forwardRequest) {
					if (signerReply.success) {
						await this.handleReplyRequest({
							requestId: forwardRequest.requestId,
							interceptorApproved: true,
							method: forwardRequest.method,
							type: 'result',
							result: signerReply.reply,
						})
						return
					}
					return pendingRequest.reject(this.parseRpcError(signerReply.error))
				}
				await this.sendMessageToBackgroundPage({ method: 'signer_reply', params: [ signerReply ] })
			} catch(error: unknown) {
				if (error instanceof Error) return pendingRequest.reject(error)
				return pendingRequest.reject(this.parseRpcError(error))
			}
		} catch(error: unknown) {
			console.error(messageEvent)
			console.error(error)
			await this.sendMessageToBackgroundPage({ method: 'InterceptorError', params: [error] })
			const requestId = 'requestId' in messageEvent.data && typeof messageEvent.data.requestId === 'number' ? messageEvent.data.requestId : undefined
			if (requestId === undefined) return
			const pendingRequest = this.outstandingRequests.get(requestId)
			if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
			if (error instanceof Error) return pendingRequest.reject(error)
			return pendingRequest.reject(this.parseRpcError(error))
		}
	}

	private enableMetamaskCompatibilityMode(enable: boolean) {
		this.metamaskCompatibilityMode = enable
		if (enable) {
			if (window.ethereum === undefined) return
			if (!('isMetamask' in window.ethereum)) try { window.ethereum.isMetaMask = true } catch(e) {}
			if ('web3' in window && window.web3 !== undefined) {
				try { window.web3.currentProvider = window.ethereum } catch(e) {}
			} else {
				try { window.web3 = { accounts: [], currentProvider: window.ethereum } } catch(e) {}
			}
		}
	}

	private readonly connectToSigner = async (signerName: Signer) => {
		this.currentSigner = signerName
		const connectToSigner = async (): Promise<{ metamaskCompatibilityMode: boolean, activeAddress: string  }> => {
			const connectSignerReply = await this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [true, signerName] })
			if (typeof connectSignerReply === 'object' && connectSignerReply !== null
				&& 'metamaskCompatibilityMode' in connectSignerReply && connectSignerReply.metamaskCompatibilityMode !== null
				&& connectSignerReply.metamaskCompatibilityMode !== undefined && typeof connectSignerReply.metamaskCompatibilityMode === 'boolean'
				&& 'activeAddress' in connectSignerReply && connectSignerReply.activeAddress !== null
				&& connectSignerReply.activeAddress !== undefined && typeof connectSignerReply.activeAddress === 'string') {
					this.currentAddress = connectSignerReply.activeAddress
					if (connectSignerReply.metamaskCompatibilityMode && window.ethereum !== undefined) {
						try { window.ethereum.selectedAddress = this.currentAddress } catch(error) { }
					}
				return connectSignerReply as { metamaskCompatibilityMode: boolean, activeAddress: string }
			}
			throw new Error('Failed to parse connected_to_signer reply')
		}

		if (signerName !== 'NoSigner') {
			if (this.waitForAccountsFromWallet === undefined && this.signerAccounts.length === 0) this.waitForAccountsFromWallet = new InterceptorFuture()
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
				icon: 'data:image/svg+xml,%3Csvg%20width%3D%2232%22%20height%3D%2232%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M8%2021.32c.03%200%20.06%200%20.08-.01h.05c.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.07-.01.1-.02.01%200%20.03%200%20.04-.01.04-.01.08-.01.12-.02h.02c.1-.02.19-.04.29-.07.01%200%20.02-.01.03-.01l.12-.03c.02%200%20.03-.01.05-.01l.1-.03c.01%200%20.01%200%20.02-.01%201.38-.44%203.08-1.52%205.14-3.68l2.07%201.52.79-5.87%203.29-2.67S8.43%205.37%206.76%205.07c-1.67-.29-4.29%201.5-5.37%202.67-.89.96.07%204.21.45%205.37.07.23.32.35.55.27l.04-.01c.17-.06.28-.22.29-.4.01-.24.1-.48.26-.68l.18-.23c.14-.17.32-.3.52-.37l2.79-.98c.36-.13.76-.07%201.07.16l4.49%203.29c.32.23.5.61.47%201l-.01.1c-.02.31-.16.6-.39.8l-.01.01-.28.25-.09.08-.2.17-.1.08c-.06.06-.13.11-.19.17l-.08.07c-.09.08-.18.15-.27.23l-.02.01c-.08.07-.16.14-.24.2l-.08.07-.18.15-.08.07c-.06.05-.12.1-.18.14l-.07.06c-.08.07-.16.13-.24.19l-.02.02c-.07.06-.14.11-.21.17l-.07.05c-.05.04-.11.08-.16.13l-.07.05c-.06.04-.11.08-.16.13l-.05.04c-.07.06-.14.11-.21.16l-.03.04H8.8c-.06.05-.12.09-.18.14l-.06.04c-.05.04-.1.07-.14.1l-.06.04c-.05.04-.1.07-.15.11l-.04.03c-.01.01-.02.01-.03.02l-.01-.01h.04l-1.21-1.3c-.87-1.53.65-3.52%201.55-4.5a.31.31%200%200%200-.04-.45l-1.5-1.1a.31.31%200%200%200-.28-.04l-2.56.89c-.05.02-.1.05-.14.1-.08.1-.09.23-.03.34l1.3%202.26c.05.09.05.19.01.29-.3.61-1.42%202.98-.8%203.64h-.02s.36.68%201.14%201.23c.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.03.02.04.02.01.01.02.01.04.02.01.01.03.02.04.02.01.01.03.01.04.02s.03.02.04.02c-.01.05.01.06.02.07.02.01.03.02.05.02.01.01.02.01.04.02s.03.02.05.02c.01.01.02.01.04.02.01.01.03.02.05.03.01%200%20.02.01.03.01.03.01.06.03.09.04.01%200%20.01%200%20.02.01.03.01.05.02.08.03.01%200%20.02.01.03.01.02.01.04.02.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02%200%20.04.01.07.01.01%200%20.03.01.04.01.02%200%20.05.01.07.01.01%200%20.03%200%20.04.01.03%200%20.05.01.08.01.01%200%20.02%200%20.03.01.03%200%20.06.01.09.01h.02c.08.01.16.01.24.02zm3.85-10.75c0-.57.46-1.03%201.03-1.03s1.03.46%201.03%201.03-.46%201.03-1.03%201.03-1.03-.46-1.03-1.03m3.44%2012.15c-2.88-.17-4.88-.79-5.41-.98l-.01.01-.33.11-.02.01c-.04.01-.08.02-.12.04h-.01l-.04.01c-.04.01-.09.02-.13.04h-.01l-.03.01c-.11.03-.23.06-.34.08h-.02l-.14.03-.04.01h-.01c-.04.01-.08.01-.12.02l-.04-.01h-.01c-.04%200-.07.01-.11.01h-.06c-.03%200-.07.01-.1.01h-.06c-.03%200-.07%200-.1.01h-.12l-.09%204.4h3.88l.3-2.38c.46.2.91.41%201.43.48v.88h-.01v1.45h3.88l.06-1.06c.04-.35.1-.76.15-1.19%201.11-.11%202.2-.36%203.26-.78.4.96.9%202.44.9%202.44h4.2l.13-5.44a24.1%2024.1%200%200%201-9.25%201.83c-.52%200-1.01-.02-1.46-.04%22%20fill%3D%22currentColor%22%2F%3E%3Cpath%20d%3D%22M30.76%2014.1c-.51-1.23-1.69-2.01-2.88-2.67.11-.24.18-.5.18-.78%200-1.04-.84-1.88-1.88-1.88s-1.88.84-1.88%201.88.84%201.88%201.88%201.88c.47%200%20.89-.19%201.22-.48%201.02%201.06%202.06%202.52-1.17%204l-.23-.63c-.5%200-1.51.5-1.51.5l.34-1c-.84-.5-2.01-.34-2.01-.34l.67-.84c-.7-.7-2.32-.58-2.85-.52.13-.06.33-.23.67-.65-.74-.3-1.32-.36-1.77-.3l-1.48%201.2-.75%205.55-.19%201.38-.03.2-2.71-1.99c-1.17%201.14-2.3%202.01-3.37%202.6%202.32.6%208.4%201.69%2015.01-1.19v-.01c2.66-1.14%205.9-3.12%204.74-5.91M19.3%2019.61c-.36-1.49-.09-3.36.67-4.69.36%201.49.1%203.35-.67%204.69m3.02%200c-.35-.96-.08-2.07.67-2.76.35.95.08%202.07-.67%202.76%22%20fill%3D%22currentColor%22%2F%3E%3C%2Fsvg%3E',
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
			this.connectToSigner(this.currentSigner)
		})
		window.ethereum.on('disconnect', (_error: ProviderRpcError) => {
			this.sendMessageToBackgroundPage({ method: 'connected_to_signer', params: [false, this.currentSigner] })
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
