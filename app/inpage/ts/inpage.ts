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

class EthereumJsonRpcError extends Error {
	constructor(public readonly code: number, message: string, public readonly data?: unknown) {
		super(message)
		this.name = this.constructor.name
	}
}

type MessageMethodAndParams = {
	readonly method: string,
	readonly params?: readonly unknown[]
	readonly internal?: true
}

const INTERNAL_BACKGROUND_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

const isInternalBackgroundMethod = (method: string) => INTERNAL_BACKGROUND_METHODS.some((internalMethod) => internalMethod === method)

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
		readonly data?: unknown
	}
}

type InterceptedRequestForwardToSigner = InterceptedRequestBase & { readonly type: 'forwardToSigner', readonly replyWithSignersReply?: true }

type InterceptedRequestForward = InterceptedRequestForwardWithResult | InterceptedRequestForwardWithError | InterceptedRequestForwardToSigner

const INTERCEPTOR_BRIDGE_PORT_MESSAGE = 'interceptor_bridge_port'
const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
const REQUEST_SCOPED_PROVIDER_EVENT_METHODS = new Set(['accountsChanged', 'connect', 'disconnect', 'chainChanged'])

type InterceptorApprovedMessageCandidate = {
	readonly interceptorApproved?: unknown
	readonly method?: unknown
	readonly type?: unknown
	readonly requestId?: unknown
	readonly params?: unknown
	readonly subscription?: unknown
	readonly replyWithSignersReply?: unknown
	readonly result?: unknown
	readonly error?: unknown
}

type InterceptorErrorCandidate = {
	readonly code?: unknown
	readonly message?: unknown
	readonly data?: unknown
}

type BridgeRequest = {
	readonly type: typeof INTERCEPTOR_BRIDGE_REQUEST_MESSAGE
	readonly method: string
	readonly params?: readonly unknown[]
	readonly usingInterceptorWithoutSigner: boolean
	readonly requestId: number
	readonly internal?: true
}

const isMessageCandidate = (value: unknown): value is InterceptorApprovedMessageCandidate => typeof value === 'object' && value !== null
const isErrorCandidate = (value: unknown): value is InterceptorErrorCandidate => typeof value === 'object' && value !== null
const isEip6963AnnouncementDetail = (value: unknown): value is { provider: unknown, info: unknown } => typeof value === 'object' && value !== null && 'provider' in value && 'info' in value
const isValidImageDataUri = (value: string) => {
	const match = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]+)*(;base64)?,(.+)$/is.exec(value)
	if (match === null) return false
	const payload = match[2]
	if (payload === undefined) return false
	if (match[1] === ';base64') return /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(payload)
	try {
		return decodeURIComponent(payload).length > 0
	} catch (_error: unknown) {
		return false
	}
}
const isEip6963MetaMaskInfo = (value: unknown): value is EIP6963ProviderInfo & { rdns: 'io.metamask' } => {
	return typeof value === 'object'
		&& value !== null
		&& 'uuid' in value
		&& typeof value.uuid === 'string'
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.uuid)
		&& 'name' in value
		&& value.name === 'MetaMask'
		&& 'icon' in value
		&& typeof value.icon === 'string'
		&& isValidImageDataUri(value.icon)
		&& 'rdns' in value
		&& value.rdns === 'io.metamask'
}
const getEip6963MetaMaskAnnouncement = (event: Event) => {
	try {
		if (!('detail' in event)) return undefined
		const detail = event.detail
		if (!isEip6963AnnouncementDetail(detail)) return undefined
		const provider = detail.provider
		const info = detail.info
		if (!isEip6963MetaMaskInfo(info)) return undefined
		return {
			provider,
			info: Object.freeze({ uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns }),
		}
	} catch (_error: unknown) {
		return undefined
	}
}
const isRequestAccountsResolution = (originalRequestMethod: string | undefined, replyMethod: string) => originalRequestMethod === 'eth_requestAccounts' && (replyMethod === 'eth_accounts' || replyMethod === 'eth_requestAccounts')
const isRequestPermissionsResolution = (originalRequestMethod: string | undefined, replyMethod: string) => originalRequestMethod === 'wallet_requestPermissions' && replyMethod === 'wallet_requestPermissions'
const shouldResolveAfterRequestScopedProviderEvents = (originalRequestMethod: string | undefined, replyMethod: string) => isRequestAccountsResolution(originalRequestMethod, replyMethod) || isRequestPermissionsResolution(originalRequestMethod, replyMethod)
const isRequestScopedProviderEventMethod = (method: string) => REQUEST_SCOPED_PROVIDER_EVENT_METHODS.has(method)
const canFallbackRequestToRootSigner = (method: string) => method === 'eth_requestAccounts'

function parseInterceptorApprovedMessage(data: unknown): InterceptedRequestForward | undefined {
	if (!isMessageCandidate(data)) return undefined
	if (data.interceptorApproved !== true) return undefined
	const method = data.method
	if (typeof method !== 'string') return undefined
	const type = data.type
	if (type !== 'result' && type !== 'forwardToSigner') return undefined
	const requestId = data.requestId
	const params = data.params
	const subscription = data.subscription
	const base = {
		interceptorApproved: true as const,
		method,
		...(typeof requestId === 'number' ? { requestId } : {}),
		...(Array.isArray(params) ? { params } : {}),
		...(typeof subscription === 'string' ? { subscription } : {}),
	}
	if (type === 'forwardToSigner') return {
		...base,
		type: 'forwardToSigner',
		...(data.replyWithSignersReply === true ? { replyWithSignersReply: true as const } : {}),
	}
	const hasResult = 'result' in data
	const maybeError = data.error
	if (hasResult && maybeError !== undefined) return undefined
	if (isErrorCandidate(maybeError)) {
		const { code, message } = maybeError
		if (typeof code !== 'number' || typeof message !== 'string') return undefined
		const errorData = maybeError.data
		return {
			...base,
			type: 'result',
			error: {
				code,
				message,
				...(errorData !== undefined ? { data: errorData } : {}),
			},
		}
	}
	if (!hasResult) return undefined
	return {
		...base,
		type: 'result',
		result: data.result,
	}
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

type JsonRpcResponse = IJsonRpcSuccess<unknown> | IJsonRpcError
type LegacyJsonRpcCallback = (error: IJsonRpcError | null, response: JsonRpcResponse | JsonRpcResponse[] | null) => void

type SignerAccountsReply =
	| { readonly type: 'success', readonly accounts: readonly string[], readonly requestAccounts: boolean }
	| { readonly type: 'error', readonly error: { readonly code: number, readonly message: string, readonly data?: unknown }, readonly requestAccounts: boolean }

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
	providers?: readonly WindowEthereum[],
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
type ForwardedDiagnosticsRequestContext = {
	readonly requestId?: number
	readonly requestMethod?: string
}

type OutstandingRequest = {
	readonly future: InterceptorFuture<unknown>
	readonly method: string
	requestScopedProviderEventCallbacks?: (() => void)[]
}

type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'
type Signer = 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Brave' | 'CoinbaseWallet'

function isForwardedDiagnosticsRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function stringifyForwardedFallbackError(error: unknown) {
	return error instanceof Error ? `${ error.name }: ${ error.message }` : `Unexpected thrown value: ${ String(error) }`
}

function stringifyForwardedFallbackValue(value: unknown) {
	try {
		return String(value)
	} catch (error: unknown) {
		return `[failed to stringify value: ${ stringifyForwardedFallbackError(error) }]`
	}
}

function stringifyForwardedThrownValue(value: unknown) {
	if (value instanceof Error) return value.stack ?? `${ value.name }: ${ value.message }`
	if (typeof value === 'bigint') return value.toString()
	try {
		const stringified = JSON.stringify(value, (_key: string, nestedValue: unknown) => typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue)
		if (stringified !== undefined) return stringified
	} catch (error: unknown) {
		const fallbackValue = stringifyForwardedFallbackValue(value)
		return `${ fallbackValue }\n\n[serialization fallback: ${ stringifyForwardedFallbackError(error) }]`
	}
	return stringifyForwardedFallbackValue(value)
}

function getForwardedDiagnosticsSummary(error: unknown) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	if (error === undefined) return 'Unexpected thrown value: undefined'
	if (error === null) return 'Unexpected thrown value: null'
	if (isForwardedDiagnosticsRecord(error)) {
		const { message } = error
		if (typeof message === 'string') return message
	}
	return String(error)
}

function getForwardedDiagnosticsRequestContext(value: unknown): ForwardedDiagnosticsRequestContext {
	if (!isForwardedDiagnosticsRecord(value)) return {}
	const { requestId, method } = value
	return {
		...(typeof requestId === 'number' ? { requestId } : {}),
		...(typeof method === 'string' ? { requestMethod: method } : {}),
	}
}

function formatForwardedDiagnostics(source: 'inpage' | 'content-script' | 'document-start', phase: string, summary: string, thrown: unknown, context: ForwardedDiagnosticsRequestContext = {}) {
	return [
		`${ source }: ${ summary }`,
		`phase: ${ phase }`,
		...(context.requestMethod !== undefined ? [`requestMethod: ${ context.requestMethod }`] : []),
		...(context.requestId !== undefined ? [`requestId: ${ context.requestId }`] : []),
		`thrown:\n${ stringifyForwardedThrownValue(thrown) }`,
	].join('\n\n')
}

function setCompatibilityProperty(target: object, property: PropertyKey, value: unknown, propertyLabel: string) {
	try {
		const ownDescriptor = Object.getOwnPropertyDescriptor(target, property)
		if (ownDescriptor !== undefined) {
			if ('value' in ownDescriptor && ownDescriptor.writable === false) {
				if (ownDescriptor.configurable !== true) return
				Object.defineProperty(target, property, {
					configurable: ownDescriptor.configurable,
					enumerable: ownDescriptor.enumerable,
					value,
					writable: true,
				})
				return
			}
			if ('set' in ownDescriptor && ownDescriptor.set === undefined) {
				if (ownDescriptor.configurable !== true) return
				Object.defineProperty(target, property, {
					configurable: ownDescriptor.configurable,
					enumerable: ownDescriptor.enumerable,
					value,
					writable: true,
				})
				return
			}
		}
		if (Reflect.set(target, property, value) === true) return
		if (!Object.isExtensible(target)) {
			console.warn(`Interceptor compatibility assignment was rejected for ${ propertyLabel }.`)
			return
		}
		if (Object.isExtensible(target)) {
			Object.defineProperty(target, property, { configurable: true, enumerable: true, writable: true, value })
		}
	} catch (error: unknown) {
		console.warn(`Interceptor compatibility assignment failed for ${ propertyLabel }.`, error)
	}
}

function serializeForwardedDiagnostics(source: 'inpage' | 'content-script' | 'document-start', phase: string, error: unknown, context: ForwardedDiagnosticsRequestContext = {}): string {
	return formatForwardedDiagnostics(source, phase, getForwardedDiagnosticsSummary(error), error, context)
}

class InterceptorMessageListener {
	private static readonly hasRequestAndOn = (provider: unknown): provider is WindowEthereum => {
		return typeof provider === 'object'
			&& provider !== null
			&& 'request' in provider
			&& typeof provider.request === 'function'
			&& 'on' in provider
			&& typeof provider.on === 'function'
	}
	private static readonly hasUsableSignerInterface = (provider: unknown): provider is WindowEthereum => {
		return InterceptorMessageListener.hasRequestAndOn(provider)
			&& (provider.isConnected === undefined || typeof provider.isConnected === 'function')
	}
	private static readonly hasNoConflictingWalletMarkers = (provider: WindowEthereum) => {
		return (provider.isMetaMask === undefined || provider.isMetaMask === true)
			&& (provider.isBraveWallet === undefined || provider.isBraveWallet === false)
			&& (provider.isCoinbaseWallet === undefined || provider.isCoinbaseWallet === false)
			&& (provider.isInterceptor === undefined || provider.isInterceptor === false)
	}

	private connected = false
	private requestId = 0
	private metamaskCompatibilityMode = false
	private signerName: Signer = 'NoSigner'
	private signerWindowEthereumProvider: WindowEthereum | undefined = undefined
	private signerWindowEthereumRequest: EthereumRequest | undefined = undefined
	private fallbackSignerWindowEthereumRequest: EthereumRequest | undefined = undefined
	private extensionMessagePort: MessagePort | undefined = undefined
	private readonly subscribedSignerProviders = new WeakSet<object>()
	private readonly rejectedSignerProviders = new WeakSet<object>()
	private announcedMetaMaskUuid: string | undefined = undefined
	private signerSelectionGeneration = 0
	private signerConnectionTransition: Promise<void> = Promise.resolve()

	private readonly outstandingRequests: Map<number, OutstandingRequest> = new Map()

	private readonly onMessageCallBacks: Set<((message: ProviderMessage) => void)> = new Set()
	private readonly onConnectCallBacks: Set<((connectInfo: ProviderConnectInfo) => void)> = new Set()
	private readonly onAccountsChangedCallBacks: Set<((accounts: readonly string[]) => void)> = new Set()
	private readonly onDisconnectCallBacks: Set<((error: ProviderRpcError) => void)> = new Set()
	private readonly onChainChangedCallBacks: Set<((chainId: string) => void)> = new Set()

	private currentAddress = ''
	private activeChainId = ''
	private ethereumSelectedAddressControlled = false
	private web3AccountsControlled = false

	private signerAccounts: string[] = []
	private pendingSignerAddressRequest: InterceptorFuture<SignerAccountsReply> | undefined = undefined

	public constructor() {
		this.connectToContentScript()
		this.injectEthereumIntoWindow()
		this.onPageLoad()
	}

	private readonly WindowEthereumIsConnected = () => this.connected

	private readonly getControlledSelectedAddress = () => this.currentAddress === '' ? undefined : this.currentAddress

	private readonly getControlledAccounts = () => this.currentAddress === '' ? [] : [this.currentAddress]

	private readonly refreshAccountCompatibilityProperties = (accounts: readonly string[]) => {
		const address = accounts[0] ?? ''
		if (this.metamaskCompatibilityMode && inpageWindow.ethereum !== undefined && !this.ethereumSelectedAddressControlled) {
			setCompatibilityProperty(inpageWindow.ethereum, 'selectedAddress', address, 'window.ethereum.selectedAddress')
		}
		if (this.metamaskCompatibilityMode && 'web3' in inpageWindow && inpageWindow.web3 !== undefined && !this.web3AccountsControlled) {
			setCompatibilityProperty(inpageWindow.web3, 'accounts', accounts, 'window.web3.accounts')
		}
	}

	private readonly hasNonConfigurableAccountCompatibilityProperty = () => {
		if (inpageWindow.ethereum !== undefined && Object.getOwnPropertyDescriptor(inpageWindow.ethereum, 'selectedAddress')?.configurable === false) return true
		if ('web3' in inpageWindow && inpageWindow.web3 !== undefined && Object.getOwnPropertyDescriptor(inpageWindow.web3, 'accounts')?.configurable === false) return true
		return false
	}

	private readonly createInterceptorProvider = (signerWindowEthereum: WindowEthereum | undefined): WindowEthereum => {
		return {
			isInterceptor: true,
			isConnected: this.WindowEthereumIsConnected.bind(signerWindowEthereum),
			request: this.WindowEthereumRequest.bind(signerWindowEthereum),
			send: this.WindowEthereumSend.bind(signerWindowEthereum),
			sendAsync: this.WindowEthereumSendAsync.bind(signerWindowEthereum),
			on: this.WindowEthereumOn.bind(signerWindowEthereum),
			removeListener: this.WindowEthereumRemoveListener.bind(signerWindowEthereum),
			enable: this.WindowEthereumEnable.bind(signerWindowEthereum),
			...this.unsupportedMethods(signerWindowEthereum),
		}
	}

	private readonly installControlledCompatibilityProperty = (target: object, property: PropertyKey, getter: () => unknown, label: string) => {
		const descriptor = Object.getOwnPropertyDescriptor(target, property)
		if (descriptor?.configurable === false) {
			if ('value' in descriptor && descriptor.writable === true) {
				const controlledValue = getter()
				const safeValue = Array.isArray(controlledValue) ? Object.freeze([...controlledValue]) : controlledValue
				try {
					Object.defineProperty(target, property, {
						...descriptor,
						value: safeValue,
						writable: false,
					})
					return true
				} catch (error: unknown) {
					console.warn(`Interceptor compatibility assignment failed for ${ label }.`, error)
					return false
				}
			}
			if ('value' in descriptor && (descriptor.value === undefined || descriptor.value === null || descriptor.value === '' || (Array.isArray(descriptor.value) && descriptor.value.length === 0))) return false
			const currentValue = Reflect.get(target, property)
			if ('set' in descriptor && descriptor.set === undefined && (currentValue === undefined || currentValue === null || currentValue === '' || (Array.isArray(currentValue) && currentValue.length === 0))) return false
			console.warn(`Interceptor compatibility assignment was rejected for ${ label }.`)
			return false
		}
		try {
			Object.defineProperty(target, property, {
				configurable: true,
				enumerable: true,
				get: getter,
				set: () => undefined,
			})
			return true
		} catch (error: unknown) {
			if (!Object.isExtensible(target)) return false
			console.warn(`Interceptor compatibility assignment failed for ${ label }.`, error)
			return false
		}
	}

	private readonly installControlledAccountCompatibilityProperties = () => {
		if (inpageWindow.ethereum !== undefined) {
			this.ethereumSelectedAddressControlled = this.installControlledCompatibilityProperty(inpageWindow.ethereum, 'selectedAddress', this.getControlledSelectedAddress, 'window.ethereum.selectedAddress')
		}
		if ('web3' in inpageWindow && inpageWindow.web3 !== undefined) {
			if (Object.getOwnPropertyDescriptor(inpageWindow.web3, 'accounts')?.configurable === false) {
				setCompatibilityProperty(inpageWindow, 'web3', { accounts: this.getControlledAccounts(), currentProvider: inpageWindow.ethereum as WindowEthereum }, 'window.web3')
			}
			this.web3AccountsControlled = this.installControlledCompatibilityProperty(inpageWindow.web3, 'accounts', this.getControlledAccounts, 'window.web3.accounts')
			setCompatibilityProperty(inpageWindow.web3, 'currentProvider', inpageWindow.ethereum as WindowEthereum, 'window.web3.currentProvider')
		}
	}

	private readonly connectToContentScript = () => {
		const channel = new MessageChannel()
		this.extensionMessagePort = channel.port1
		channel.port1.onmessage = (messageEvent: MessageEvent<unknown>) => { void this.onMessage(messageEvent) }
		window.postMessage({ type: INTERCEPTOR_BRIDGE_PORT_MESSAGE }, '*', [channel.port2])
	}

	private readonly sendMessageToBackgroundPage = async (messageMethodAndParams: MessageMethodAndParams) => {
		this.requestId++
		const pendingRequestId = this.requestId
		const future = new InterceptorFuture<unknown>()
		this.outstandingRequests.set(pendingRequestId, {
			future,
			method: messageMethodAndParams.method,
			requestScopedProviderEventCallbacks: [],
		})
		try {
			if (this.extensionMessagePort === undefined) throw new Error('Interceptor content script bridge is not connected')
			const message: BridgeRequest = {
				type: INTERCEPTOR_BRIDGE_REQUEST_MESSAGE,
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
				usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
				requestId: pendingRequestId,
				...(messageMethodAndParams.internal === true ? { internal: true as const } : {}),
			}
			this.extensionMessagePort.postMessage(message)
			return await future
		} finally {
			this.outstandingRequests.delete(pendingRequestId)
		}
	}

	private readonly drainRequestScopedProviderEventCallbacks = (requestId: number) => {
		const outstandingRequest = this.outstandingRequests.get(requestId)
		const providerEventCallbacks = outstandingRequest?.requestScopedProviderEventCallbacks ?? []
		if (outstandingRequest !== undefined) delete outstandingRequest.requestScopedProviderEventCallbacks
		let firstCallbackError: unknown
		for (const callback of providerEventCallbacks) {
			try {
				callback()
			} catch (error: unknown) {
				if (firstCallbackError === undefined) firstCallbackError = error
			}
		}
		return firstCallbackError
	}

	private readonly resolveWithRequestScopedProviderEvents = (requestId: number, value: unknown) => {
		const callbackError = this.drainRequestScopedProviderEventCallbacks(requestId)
		this.outstandingRequests.get(requestId)?.future.resolve(value)
		if (callbackError !== undefined) throw callbackError
	}

	private readonly sendInternalMessageToBackgroundPage = async (messageMethodAndParams: Omit<MessageMethodAndParams, 'internal'>) => {
		return await this.sendMessageToBackgroundPage({ ...messageMethodAndParams, internal: true })
	}

	private readonly reportInterceptorError = (diagnostics: string) => {
		try {
			if (this.extensionMessagePort === undefined) return
			const message: BridgeRequest = {
				type: INTERCEPTOR_BRIDGE_REQUEST_MESSAGE,
				method: 'InterceptorError',
				params: [diagnostics],
				usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
				requestId: -1,
				internal: true,
			}
			this.extensionMessagePort.postMessage(message)
		} catch(reportingError: unknown) {
			console.error('Failed to report InterceptorError diagnostics')
			console.error(reportingError)
		}
	}

	// sends a message to interceptors background script
	private readonly WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }) => {
		try {
			if (isInternalBackgroundMethod(methodAndParams.method)) throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, `Method not supported: ${ methodAndParams.method }`)
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			return await this.sendMessageToBackgroundPage({
				method: methodAndParams.method,
				...(methodAndParams.params !== undefined ? { params: methodAndParams.params } : {}),
			})
		} catch (error: unknown) {
			if (error instanceof Error) throw error
			throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { error: error, request: methodAndParams })
		}
	}

	private readonly requestFromSigner = async (methodAndParams: { readonly method: string, readonly params?: readonly unknown[] }, allowRequestAccountsFallbackToRoot = false) => {
		if (this.signerWindowEthereumRequest === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
		try {
			return await this.signerWindowEthereumRequest(methodAndParams)
		} catch (error: unknown) {
			if (!allowRequestAccountsFallbackToRoot || this.fallbackSignerWindowEthereumRequest === undefined) throw error
			if (methodAndParams.method === 'eth_accounts') throw error
			if (!canFallbackRequestToRootSigner(methodAndParams.method)) throw error
			if (InterceptorMessageListener.isUserRejectedRequestError(error)) throw error
			return await this.fallbackSignerWindowEthereumRequest(methodAndParams)
		}
	}

	private readonly subscribeToSignerEvents = (provider: WindowEthereum, signerName: Signer, signerOn = provider.on.bind(provider), signerRemoveListener = provider.removeListener.bind(provider)) => {
		if (this.subscribedSignerProviders.has(provider)) return
		const registrations: { readonly kind: OnMessage, readonly callback: AnyCallBack }[] = []
		const register = (kind: OnMessage, callback: AnyCallBack) => {
			registrations.push({ kind, callback })
			signerOn(kind, callback)
		}
		try {
			register('accountsChanged', (accounts: readonly string[]) => {
				if (this.signerWindowEthereumProvider !== provider) return
				if (!Array.isArray(accounts)) return
				if (!InterceptorMessageListener.isStringArray([...accounts])) return
				this.signerAccounts = [...accounts]
				if (this.pendingSignerAddressRequest !== undefined) return
				this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: false }] })
			})
			register('connect', (_connectInfo: ProviderConnectInfo) => {
				if (this.signerWindowEthereumProvider !== provider) return
				this.connectToSigner(signerName)
			})
			register('disconnect', (_error: ProviderRpcError) => {
				if (this.signerWindowEthereumProvider !== provider) return
				this.sendInternalMessageToBackgroundPage({ method: 'connected_to_signer', params: [false, signerName] })
			})
			register('chainChanged', (chainId: string) => {
				if (this.signerWindowEthereumProvider !== provider) return
				// TODO: this is a hack to get coinbase working that calls this numbers in base 10 instead of in base 16
				const params = /\d/.test(chainId) ? [`0x${parseInt(chainId).toString(16)}`] : [chainId]
				this.sendInternalMessageToBackgroundPage({ method: 'signer_chainChanged', params })
			})
			this.subscribedSignerProviders.add(provider)
		} catch (error: unknown) {
			this.rejectedSignerProviders.add(provider)
			for (const registration of registrations.reverse()) {
				try {
					signerRemoveListener(registration.kind, registration.callback)
				} catch (_rollbackError: unknown) {
					this.rejectedSignerProviders.add(provider)
				}
			}
			throw error
		}
	}

	private readonly trySubscribeToSignerEvents = (provider: WindowEthereum, signerName: Signer, signerOn = provider.on.bind(provider), signerRemoveListener = provider.removeListener.bind(provider)) => {
		if (this.rejectedSignerProviders.has(provider)) return false
		try {
			this.subscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)
			return true
		} catch (_error: unknown) {
			return false
		}
	}

	private readonly prepareSignerProvider = (provider: unknown, signerName: Signer, requireMetaMaskMarker = false, requireMetaMaskConsistency = true) => {
		try {
			if (!InterceptorMessageListener.hasUsableSignerInterface(provider)) return undefined
			if (requireMetaMaskMarker && provider.isMetaMask !== true) return undefined
			if (requireMetaMaskConsistency && !InterceptorMessageListener.hasNoConflictingWalletMarkers(provider)) return undefined
			const request = provider.request.bind(provider)
			const signerOn = provider.on.bind(provider)
			const signerRemoveListener = provider.removeListener.bind(provider)
			const connected = provider.isConnected === undefined || provider.isConnected()
			if (!this.trySubscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)) return undefined
			return { provider, connected, request }
		} catch (_error: unknown) {
			return undefined
		}
	}

	private readonly findPreparedLegacyMetaMaskProvider = (injectedWindowEthereum: WindowEthereum) => {
		let providers: readonly unknown[] | undefined
		try {
			const possibleProviders = injectedWindowEthereum.providers
			if (Array.isArray(possibleProviders)) providers = possibleProviders
		} catch (_error: unknown) {
			return undefined
		}
		if (providers === undefined) return undefined
		let providerCount = 0
		try {
			providerCount = providers.length
		} catch (_error: unknown) {
			return undefined
		}
		for (let providerIndex = 0; providerIndex < providerCount; providerIndex++) {
			let provider: unknown
			try {
				provider = providers[providerIndex]
			} catch (_error: unknown) {
				continue
			}
			if (provider === injectedWindowEthereum) continue
			const preparedSigner = this.prepareSignerProvider(provider, 'MetaMask', true)
			if (preparedSigner !== undefined) return preparedSigner
		}
		return undefined
	}

	private readonly useAnnouncedMetaMaskProvider = (event: Event) => {
		const announcement = getEip6963MetaMaskAnnouncement(event)
		if (announcement === undefined) return
		const { provider, info } = announcement
		if (provider === this.signerWindowEthereumProvider) return
		if (this.announcedMetaMaskUuid !== undefined) return
		if (this.signerName !== 'NoSigner' && this.signerName !== 'MetaMask' && this.signerName !== 'Brave') return
		const preparedSigner = this.prepareSignerProvider(provider, 'MetaMask')
		if (preparedSigner === undefined) return
		this.announcedMetaMaskUuid = info.uuid
		this.signerWindowEthereumProvider = preparedSigner.provider
		this.signerWindowEthereumRequest = preparedSigner.request
		this.fallbackSignerWindowEthereumRequest = undefined
		this.connected = preparedSigner.connected
		this.connectToSigner('MetaMask')
	}

	private readonly WindowEthereumSend = (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] } | string, maybeCallBack: undefined | LegacyJsonRpcCallback) => {
		const fullPayload = typeof payload === 'string' ? { method: payload, id: 1, params: [] } : payload
		if (maybeCallBack !== undefined && typeof maybeCallBack === 'function') return this.WindowEthereumSendAsync(fullPayload, maybeCallBack)
		if (this.metamaskCompatibilityMode) {
			if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is missing')
			switch (fullPayload.method) {
				case 'eth_coinbase': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.selectedAddress ?? null }
				case 'eth_accounts': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.selectedAddress === undefined || inpageWindow.ethereum.selectedAddress === null ? [] : [inpageWindow.ethereum.selectedAddress] }
				case 'net_version': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.networkVersion }
				case 'eth_chainId': return { jsonrpc: '2.0', id: fullPayload.id, result: inpageWindow.ethereum.chainId }
				default: throw new EthereumJsonRpcError(METAMASK_INVALID_METHOD_PARAMS, `Invalid method parameter for window.ethereum.send: ${ fullPayload.method }`)
			}
		}
		throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, 'Method not supported (window.ethereum.send).')
	}

	private readonly getWindowEthereumSendAsyncResponse = async (param: SingleSendAsyncParam): Promise<JsonRpcResponse> => {
		try {
			const result = await this.WindowEthereumRequest(param)
			return { jsonrpc: '2.0', id: param.id, result }
		} catch (error) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error)) {
				const data = 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data : {}
				const stack = 'stack' in error && typeof error.stack === 'string' ? { stack: error.stack } : {}
				return {
					jsonrpc: '2.0',
					id: param.id,
					error: {
						code: error.code,
						message: error.message,
						data: { ...data, ...stack }
					}
				}
			}
			return {
				jsonrpc: '2.0',
				id: param.id,
				error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR }
			}
		}
	}

	private readonly WindowEthereumSendAsync = async (payload: SingleSendAsyncParam | SingleSendAsyncParam[], callback: LegacyJsonRpcCallback) => {
		if (Array.isArray(payload)) {
			const responses = await Promise.all(payload.map((param) => this.getWindowEthereumSendAsyncResponse(param)))
			callback(null, responses)
			return
		}
		const response = await this.getWindowEthereumSendAsyncResponse(payload)
		if ('error' in response) {
			callback(response, null)
			return
		}
		callback(null, response)
	}

	static exhaustivenessCheck = (_thing: never) => undefined

	private readonly WindowEthereumOn = (kind: OnMessage, callback: AnyCallBack) => {
		if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
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
		return inpageWindow.ethereum
	}

	private readonly WindowEthereumRemoveListener = (kind: OnMessage, callback: AnyCallBack) => {
		if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
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
		return inpageWindow.ethereum
	}

	private readonly WindowEthereumEnable = async () => this.WindowEthereumRequest({ method: 'eth_requestAccounts' })

	// attempts to call signer for eth_accounts
	private readonly getAccountsFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		try {
			const reply = await this.requestFromSigner({ method: 'eth_accounts', params: [] })
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			if (!InterceptorMessageListener.isStringArray(reply)) throw new Error('Signer did not return a string array')
			this.signerAccounts = reply
			await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: false }] })
			return
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error)) return await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error }] })
			const errorCode = InterceptorMessageListener.getErrorCode(error)
			if (errorCode !== undefined) return await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: InterceptorMessageListener.getFallbackErrorMessage(errorCode), code: errorCode } }] })
			if (error instanceof Error) return await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }] })
			return await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'error', requestAccounts: false, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }] })
		}
	}

	private static isStringArray(arr: unknown[]): arr is string[] {
		return arr.every(item => typeof item === 'string');
	}

	// attempts to call signer for eth_requestAccounts
	private readonly requestAccountsFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		if (this.pendingSignerAddressRequest !== undefined) {
			const pendingReply = await this.pendingSignerAddressRequest
			await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [pendingReply] })
			return
		}
		this.pendingSignerAddressRequest = new InterceptorFuture()
		try {
			const reply = await this.requestFromSigner({ method: 'eth_requestAccounts', params: [] }, true)
			if (!Array.isArray(reply)) throw new Error('Signer returned something else than an array')
			if (!InterceptorMessageListener.isStringArray(reply)) throw new Error('Signer did not return a string array')
			this.signerAccounts = reply
			const signerReply = { type: 'success', accounts: this.signerAccounts, requestAccounts: true } as const
			this.pendingSignerAddressRequest.resolve(signerReply)
			await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [signerReply] })
			return
		} catch (error: unknown) {
			const errorCode = InterceptorMessageListener.getErrorCode(error)
			const signerReply = InterceptorMessageListener.getErrorCodeAndMessage(error)
				? { type: 'error', requestAccounts: true, error } as const
				: errorCode !== undefined
					? { type: 'error', requestAccounts: true, error: { message: InterceptorMessageListener.getFallbackErrorMessage(errorCode), code: errorCode } } as const
					: error instanceof Error
						? { type: 'error', requestAccounts: true, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } } as const
						: { type: 'error', requestAccounts: true, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } } as const
			this.pendingSignerAddressRequest.resolve(signerReply)
			return await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [signerReply] })
		} finally {
			this.pendingSignerAddressRequest = undefined
		}
	}

	private readonly requestChainIdFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		try {
			const reply = await this.requestFromSigner({ method: 'eth_chainId', params: [] })
			if (typeof reply !== 'string') {
				this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', new Error('Signer eth_chainId returned a non-string reply.'), { requestMethod: 'eth_chainId' }))
				return
			}
			return await this.sendInternalMessageToBackgroundPage({ method: 'signer_chainChanged', params: [ reply ] })
		} catch(error: unknown) {
			console.error('failed to get chain Id from signer')
			console.error(error)
			this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', error, { requestMethod: 'eth_chainId' }))
			return undefined
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

	private static readonly getErrorCode = (error: unknown) => {
		if (typeof error !== 'object') return undefined
		if (error === null) return undefined
		if (!('code' in error)) return undefined
		return typeof error.code === 'number' ? error.code : undefined
	}

	private static readonly getFallbackErrorMessage = (errorCode: number) => errorCode === METAMASK_ERROR_USER_REJECTED_REQUEST ? 'User rejected the request.' : 'Signer request failed.'

	private static readonly isUserRejectedRequestError = (error: unknown): error is { code: number } => {
		return InterceptorMessageListener.getErrorCode(error) === METAMASK_ERROR_USER_REJECTED_REQUEST
	}

	private static readonly getProviderConnectInfo = (result: unknown): ProviderConnectInfo => {
		if (typeof result === 'string') return { chainId: result }
		if (Array.isArray(result) && typeof result[0] === 'string') return { chainId: result[0] }
		throw new Error('wrong type')
	}

	private readonly requestChangeChainFromSigner = async (chainId: string) => {
		if (this.signerWindowEthereumRequest === undefined) return

		try {
			const reply = await this.requestFromSigner({ method: 'wallet_switchEthereumChain', params: [ { chainId } ] })
			if (reply !== null) return
			await this.sendInternalMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: true, chainId: chainId } ] })
		} catch (error: unknown) {
			if (InterceptorMessageListener.getErrorCodeAndMessage(error) && (error.code === METAMASK_ERROR_USER_REJECTED_REQUEST || error.code === METAMASK_ERROR_CHAIN_NOT_ADDED_TO_METAMASK)) {
				await this.sendInternalMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [ { accept: false, chainId: chainId, error } ] })
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
					const replyAddress = reply[0] ?? ''
					const replayedForSettledRequest = replyRequest.requestId !== undefined
					const notifyAccountsChanged = () => {
						if (this.currentAddress === replyAddress && !replayedForSettledRequest) return
						this.currentAddress = replyAddress
						this.refreshAccountCompatibilityProperties(reply)
						for (const callback of this.onAccountsChangedCallBacks) {
							callback(reply)
						}
					}
					if (replayedForSettledRequest) {
						const callbacks = this.outstandingRequests.get(replyRequest.requestId)?.requestScopedProviderEventCallbacks
						if (callbacks !== undefined) {
							callbacks.push(notifyAccountsChanged)
							return
						}
						return
					}
					if (this.currentAddress === replyAddress && !replayedForSettledRequest) return
					notifyAccountsChanged()
					return
				}
				case 'connect': {
					const notifyConnect = () => {
						this.connected = true
						for (const callback of this.onConnectCallBacks) {
							callback(InterceptorMessageListener.getProviderConnectInfo(replyRequest.result))
						}
					}
					if (replyRequest.requestId !== undefined) {
						const callbacks = this.outstandingRequests.get(replyRequest.requestId)?.requestScopedProviderEventCallbacks
						if (callbacks !== undefined) {
							callbacks.push(notifyConnect)
							return
						}
						return
					}
					if (this.connected) return
					this.connected = true
					notifyConnect()
					return
				}
				case 'disconnect': {
					if (replyRequest.requestId !== undefined) return
					if (!this.connected) return
					this.connected = false
					for (const callback of this.onDisconnectCallBacks) {
						callback({ name: 'disconnect', code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User refused access to the wallet' })
					}
					return
				}
				case 'chainChanged': {
					if (replyRequest.requestId !== undefined) return
					const reply = replyRequest.result as string
					if (this.activeChainId === reply) return
					this.activeChainId = reply
					if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && inpageWindow.ethereum !== undefined) {
						setCompatibilityProperty(inpageWindow.ethereum, 'chainId', reply, 'window.ethereum.chainId')
						setCompatibilityProperty(inpageWindow.ethereum, 'networkVersion', Number(reply).toString(10), 'window.ethereum.networkVersion')
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
			if (isRequestScopedProviderEventMethod(replyRequest.method)) return
			const pending = this.outstandingRequests.get(replyRequest.requestId)
			if (pending === undefined) return
			const originalRequestMethod = pending.method
			if (shouldResolveAfterRequestScopedProviderEvents(originalRequestMethod, replyRequest.method)) {
				this.resolveWithRequestScopedProviderEvents(replyRequest.requestId, replyRequest.result)
				return
			}
			return pending.future.resolve(replyRequest.result)
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
		if (InterceptorMessageListener.getErrorCodeAndMessage(maybeErrorObject)) return new EthereumJsonRpcError(maybeErrorObject.code, maybeErrorObject.message, 'data' in maybeErrorObject && maybeErrorObject.data !== undefined ? maybeErrorObject.data : undefined)
		const errorCode = InterceptorMessageListener.getErrorCode(maybeErrorObject)
		if (errorCode !== undefined) return new EthereumJsonRpcError(errorCode, InterceptorMessageListener.getFallbackErrorMessage(errorCode), 'data' in maybeErrorObject && maybeErrorObject.data !== undefined ? maybeErrorObject.data : undefined)
		return new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', maybeErrorObject )
	}

	public readonly onWindowMessage = (messageEvent: unknown) => {
		this.checkIfCoinbaseInjectionMessageAndInject(messageEvent)
	}

	public readonly onMessage = async (messageEvent: unknown) => {
		if (
			typeof messageEvent !== 'object'
			|| messageEvent === null
			|| !('data' in messageEvent)
			|| typeof messageEvent.data !== 'object'
			|| messageEvent.data === null
		) return
		try {
			if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) throw new Error('window.ethereum missing')
			const forwardRequest = parseInterceptorApprovedMessage(messageEvent.data)
			if (forwardRequest === undefined) throw new Error('Malformed message from content script')
			if (!('type' in messageEvent)) throw new Error('missing type field')
			if (forwardRequest.type === 'result' && 'error' in forwardRequest) {
				if (forwardRequest.requestId === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
				const pending = this.outstandingRequests.get(forwardRequest.requestId)
				if (pending === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
				return pending.future.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data))
			}
			if (forwardRequest.type === 'result' && 'result' in forwardRequest) {
				if (this.metamaskCompatibilityMode && this.signerWindowEthereumRequest === undefined && inpageWindow.ethereum !== undefined) {
					switch (forwardRequest.method) {
						case 'eth_requestAccounts':
						case 'eth_accounts': {
							if (!Array.isArray(forwardRequest.result) || forwardRequest.result === null) throw new Error('wrong type')
							const addrArray = forwardRequest.result as string[]
							const addr = addrArray[0] ?? ''
							this.currentAddress = addr
							this.refreshAccountCompatibilityProperties(addrArray)
							break
						}
						case 'eth_chainId': {
							if (typeof forwardRequest.result !== 'string') throw new Error('wrong type')
							const chainId = forwardRequest.result as string
							setCompatibilityProperty(inpageWindow.ethereum, 'chainId', chainId, 'window.ethereum.chainId')
							setCompatibilityProperty(inpageWindow.ethereum, 'networkVersion', Number(chainId).toString(10), 'window.ethereum.networkVersion')
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
			if (this.signerWindowEthereumRequest === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')

			const sendToSignerWithCatchError = async () => {
				try {
					const reply = await this.requestFromSigner({ method: forwardRequest.method, params: 'params' in forwardRequest ? forwardRequest.params : [] })
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
				return pendingRequest.future.reject(this.parseRpcError(signerReply.error))
			}
			await this.sendInternalMessageToBackgroundPage({ method: 'signer_reply', params: [ signerReply ] })
		} catch(error: unknown) {
			if (error instanceof Error) return pendingRequest.future.reject(error)
			return pendingRequest.future.reject(this.parseRpcError(error))
		}
	} catch(error: unknown) {
			console.error(messageEvent)
			console.error(error)
			this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'handle background reply', error, getForwardedDiagnosticsRequestContext(messageEvent.data)))
			const requestId = 'requestId' in messageEvent.data && typeof messageEvent.data.requestId === 'number' ? messageEvent.data.requestId : undefined
			if (requestId === undefined) return
			const pendingRequest = this.outstandingRequests.get(requestId)
			if (pendingRequest === undefined) return
			if (error instanceof Error) return pendingRequest.future.reject(error)
			return pendingRequest.future.reject(this.parseRpcError(error))
		}
	}

	private enableMetamaskCompatibilityMode(enable: boolean) {
		this.metamaskCompatibilityMode = enable
		if (enable) {
			if (inpageWindow.ethereum === undefined) return
			if (!('isMetamask' in inpageWindow.ethereum)) setCompatibilityProperty(inpageWindow.ethereum, 'isMetaMask', true, 'window.ethereum.isMetaMask')
			if ('web3' in inpageWindow && inpageWindow.web3 !== undefined) {
				setCompatibilityProperty(inpageWindow.web3, 'currentProvider', inpageWindow.ethereum, 'window.web3.currentProvider')
			} else {
				setCompatibilityProperty(inpageWindow, 'web3', { accounts: [], currentProvider: inpageWindow.ethereum }, 'window.web3')
			}
			this.installControlledAccountCompatibilityProperties()
		}
	}

	private readonly connectToSigner = (signerName: Signer) => {
		this.signerName = signerName
		const selectionGeneration = ++this.signerSelectionGeneration
		const connectToSigner = async (): Promise<{ metamaskCompatibilityMode: boolean }> => {
			const connectSignerReply = await this.sendInternalMessageToBackgroundPage({ method: 'connected_to_signer', params: [true, signerName] })
			if (typeof connectSignerReply === 'object' && connectSignerReply !== null
				&& 'metamaskCompatibilityMode' in connectSignerReply && connectSignerReply.metamaskCompatibilityMode !== null
				&& connectSignerReply.metamaskCompatibilityMode !== undefined && typeof connectSignerReply.metamaskCompatibilityMode === 'boolean') {
				return { metamaskCompatibilityMode: connectSignerReply.metamaskCompatibilityMode }
			}
			throw new Error('Failed to parse connected_to_signer reply')
		}

		const completeTransition = async () => {
			const connection = await connectToSigner()
			if (selectionGeneration !== this.signerSelectionGeneration) return
			this.enableMetamaskCompatibilityMode(connection.metamaskCompatibilityMode)
			if (signerName !== 'NoSigner') await this.requestChainIdFromSigner()
		}
		const transition = this.signerConnectionTransition.then(completeTransition, completeTransition)
		this.signerConnectionTransition = transition
		return transition
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
		window.addEventListener('eip6963:announceProvider', this.useAnnouncedMetaMaskProvider)
		function announceProvider() {
			const info: EIP6963ProviderInfo = {
				uuid: '200ecd95-afe4-4684-bce7-0f2f8bdd3498',
				name: 'The Interceptor',
				icon: 'data:image/svg+xml,%3Csvg%20width%3D%2232%22%20height%3D%2232%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M8%2021.32c.03%200%20.06%200%20.08-.01h.05c.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.07-.01.1-.02.01%200%20.03%200%20.04-.01.04-.01.08-.01.12-.02h.02c.1-.02.19-.04.29-.07.01%200%20.02-.01.03-.01l.12-.03c.02%200%20.03-.01.05-.01l.1-.03c.01%200%20.01%200%20.02-.01%201.38-.44%203.08-1.52%205.14-3.68l2.07%201.52.79-5.87%203.29-2.67S8.43%205.37%206.76%205.07c-1.67-.29-4.29%201.5-5.37%202.67-.89.96.07%204.21.45%205.37.07.23.32.35.55.27l.04-.01c.17-.06.28-.22.29-.4.01-.24.1-.48.26-.68l.18-.23c.14-.17.32-.3.52-.37l2.79-.98c.36-.13.76-.07%201.07.16l4.49%203.29c.32.23.5.61.47%201l-.01.1c-.02.31-.16.6-.39.8l-.01.01-.28.25-.09.08-.2.17-.1.08c-.06.06-.13.11-.19.17l-.08.07c-.09.08-.18.15-.27.23l-.02.01c-.08.07-.16.14-.24.2l-.08.07-.18.15-.08.07c-.06.05-.12.1-.18.14l-.07.06c-.08.07-.16.13-.24.19l-.02.02c-.07.06-.14.11-.21.17l-.07.05c-.05.04-.11.08-.16.13l-.07.05c-.06.04-.11.08-.16.13l-.05.04c-.07.06-.14.11-.21.16l-.03.04H8.8c-.06.05-.12.09-.18.14l-.06.04c-.05.04-.1.07-.14.1l-.06.04c-.05.04-.1.07-.15.11l-.04.03c-.01.01-.02.01-.03.02l-.01-.01h.04l-1.21-1.3c-.87-1.53.65-3.52%201.55-4.5a.31.31%200%200%200-.04-.45l-1.5-1.1a.31.31%200%200%200-.28-.04l-2.56.89c-.05.02-.1.05-.14.1-.08.1-.09.23-.03.34l1.3%202.26c.05.09.05.19.01.29-.3.61-1.42%202.98-.8%203.64h-.02s.36.68%201.14%201.23c.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.03.02.04.02.01.01.02.01.04.02.01.01.03.02.04.02.01.01.03.01.04.02s.03.02.04.02c-.01.05.01.06.02.07.02.01.03.02.05.02.01.01.02.01.04.02s.03.02.05.02c.01.01.02.01.04.02.01.01.03.02.05.03.01%200%20.02.01.03.01.03.01.06.03.09.04.01%200%20.01%200%20.02.01.03.01.05.02.08.03.01%200%20.02.01.03.01.02.01.04.02.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02%200%20.04.01.07.01.01%200%20.03.01.04.01.02%200%20.05.01.07.01.01%200%20.03%200%20.04.01.03%200%20.05.01.08.01.01%200%20.02%200%20.03.01.03%200%20.06.01.09.01h.02c.08.01.16.01.24.02zm3.85-10.75c0-.57.46-1.03%201.03-1.03s1.03.46%201.03%201.03-.46%201.03-1.03%201.03-1.03-.46-1.03-1.03m3.44%2012.15c-2.88-.17-4.88-.79-5.41-.98l-.01.01-.33.11-.02.01c-.04.01-.08.02-.12.04h-.01l-.04.01c-.04.01-.09.02-.13.04h-.01l-.03.01c-.11.03-.23.06-.34.08h-.02l-.14.03-.04.01h-.01c-.04.01-.08.01-.12.02l-.04-.01h-.01c-.04%200-.07.01-.11.01h-.06c-.03%200-.07.01-.1.01h-.06c-.03%200-.07%200-.1.01h-.12l-.09%204.4h3.88l.3-2.38c.46.2.91.41%201.43.48v.88h-.01v1.45h3.88l.06-1.06c.04-.35.1-.76.15-1.19%201.11-.11%202.2-.36%203.26-.78.4.96.9%202.44.9%202.44h4.2l.13-5.44a24.1%2024.1%200%200%201-9.25%201.83c-.52%200-1.01-.02-1.46-.04%22%20fill%3D%22currentColor%22%2F%3E%3Cpath%20d%3D%22M30.76%2014.1c-.51-1.23-1.69-2.01-2.88-2.67.11-.24.18-.5.18-.78%200-1.04-.84-1.88-1.88-1.88s-1.88.84-1.88%201.88.84%201.88%201.88%201.88c.47%200%20.89-.19%201.22-.48%201.02%201.06%202.06%202.52-1.17%204l-.23-.63c-.5%200-1.51.5-1.51.5l.34-1c-.84-.5-2.01-.34-2.01-.34l.67-.84c-.7-.7-2.32-.58-2.85-.52.13-.06.33-.23.67-.65-.74-.3-1.32-.36-1.77-.3l-1.48%201.2-.75%205.55-.19%201.38-.03.2-2.71-1.99c-1.17%201.14-2.3%202.01-3.37%202.6%202.32.6%208.4%201.69%2015.01-1.19v-.01c2.66-1.14%205.9-3.12%204.74-5.91M19.3%2019.61c-.36-1.49-.09-3.36.67-4.69.36%201.49.1%203.35-.67%204.69m3.02%200c-.35-.96-.08-2.07.67-2.76.35.95.08%202.07-.67%202.76%22%20fill%3D%22currentColor%22%2F%3E%3C%2Fsvg%3E',
				rdns: 'dark.florist'
			}

			if (inpageWindow.ethereum === undefined || !inpageWindow.ethereum.isInterceptor) interceptorMessageListener.injectEthereumIntoWindow()
			const provider = inpageWindow.ethereum
			if (provider === undefined) throw new Error('The Interceptor provider was not initialized')
			window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
		}
		window.addEventListener('eip6963:requestProvider', () => { announceProvider() } )
		announceProvider()
		window.dispatchEvent(new Event('eip6963:requestProvider'))
	}

	public readonly injectEthereumIntoWindow = () => {
		if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) {
			// no existing signer found
			inpageWindow.ethereum = {
				isInterceptor: true,
				isConnected: this.WindowEthereumIsConnected.bind(inpageWindow.ethereum),
				request: this.WindowEthereumRequest.bind(inpageWindow.ethereum),
				send: this.WindowEthereumSend.bind(inpageWindow.ethereum),
				sendAsync: this.WindowEthereumSendAsync.bind(inpageWindow.ethereum),
				on: this.WindowEthereumOn.bind(inpageWindow.ethereum),
				removeListener: this.WindowEthereumRemoveListener.bind(inpageWindow.ethereum),
				enable: this.WindowEthereumEnable.bind(inpageWindow.ethereum),
				...this.unsupportedMethods(inpageWindow.ethereum),
			}
			this.connected = true
			this.connectToSigner('NoSigner')
			return
		}
		const injectedWindowEthereum = inpageWindow.ethereum
		const useNoSigner = () => {
			inpageWindow.ethereum = this.createInterceptorProvider(undefined)
			this.connected = true
			this.signerWindowEthereumProvider = undefined
			this.signerWindowEthereumRequest = undefined
			this.fallbackSignerWindowEthereumRequest = undefined
			this.connectToSigner('NoSigner')
		}
		let rootIsInterceptor = false
		try { rootIsInterceptor = injectedWindowEthereum.isInterceptor === true } catch (_error: unknown) { rootIsInterceptor = false }
		if (rootIsInterceptor) return
		const preparedMetaMaskProvider = this.findPreparedLegacyMetaMaskProvider(injectedWindowEthereum)

		let rootIsBraveWallet = false
		let rootIsCoinbaseWallet = false
		let rootIsMetaMask = false
		let rootProviderMap: Map<string, WindowEthereum> | undefined
		try { rootIsBraveWallet = injectedWindowEthereum.isBraveWallet === true } catch (_error: unknown) { rootIsBraveWallet = false }
		try { rootIsCoinbaseWallet = injectedWindowEthereum.isCoinbaseWallet === true } catch (_error: unknown) { rootIsCoinbaseWallet = false }
		try { rootIsMetaMask = injectedWindowEthereum.isMetaMask === true } catch (_error: unknown) { rootIsMetaMask = false }
		try { rootProviderMap = injectedWindowEthereum.providerMap } catch (_error: unknown) { rootProviderMap = undefined }
		const rootSignerName = rootIsCoinbaseWallet ? 'CoinbaseWallet' as const : rootIsBraveWallet ? 'Brave' as const : rootIsMetaMask ? 'MetaMask' as const : 'NotRecognizedSigner' as const

		if (preparedMetaMaskProvider === undefined && (rootIsBraveWallet || rootProviderMap !== undefined || rootIsCoinbaseWallet)) {
			let mapSignerWindowEthereum: WindowEthereum | undefined
			try { mapSignerWindowEthereum = rootProviderMap?.get('CoinbaseWallet') } catch (_error: unknown) { mapSignerWindowEthereum = undefined }
			const preparedMapSigner = this.prepareSignerProvider(mapSignerWindowEthereum, 'CoinbaseWallet', false, false)
			const preparedRootSigner = preparedMapSigner === undefined ? this.prepareSignerProvider(injectedWindowEthereum, rootSignerName, false, false) : undefined
			const preparedSigner = preparedMapSigner ?? preparedRootSigner
			if (preparedSigner === undefined) {
				useNoSigner()
				return
			}
			const signerName = preparedMapSigner === undefined ? rootSignerName : 'CoinbaseWallet'
			let fallbackRequest: EthereumRequest | undefined
			if (preparedMapSigner !== undefined) {
				try { fallbackRequest = injectedWindowEthereum.request.bind(injectedWindowEthereum) } catch (_error: unknown) { fallbackRequest = undefined }
			}
			this.connected = preparedSigner.connected
			this.signerWindowEthereumProvider = preparedSigner.provider
			this.signerWindowEthereumRequest = preparedSigner.request
			this.fallbackSignerWindowEthereumRequest = fallbackRequest
			inpageWindow.ethereum = this.createInterceptorProvider(preparedSigner.provider)
			this.installControlledAccountCompatibilityProperties()
			this.connectToSigner(signerName)
			return
		}
		const preparedRootSigner = preparedMetaMaskProvider ?? this.prepareSignerProvider(injectedWindowEthereum, rootSignerName, false, false)
		if (preparedRootSigner === undefined) {
			useNoSigner()
			return
		}
		const fallbackSignerWindowEthereum = preparedRootSigner.provider
		const fallbackSignerName = preparedMetaMaskProvider === undefined ? rootSignerName : 'MetaMask'
		this.signerWindowEthereumProvider = fallbackSignerWindowEthereum
		this.signerWindowEthereumRequest = preparedRootSigner.request // store the request object to signer
		this.fallbackSignerWindowEthereumRequest = undefined
		this.connected = preparedRootSigner.connected
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		if (fallbackSignerWindowEthereum !== injectedWindowEthereum || this.hasNonConfigurableAccountCompatibilityProperty()) {
			this.installControlledAccountCompatibilityProperties()
			inpageWindow.ethereum = this.createInterceptorProvider(fallbackSignerWindowEthereum)
		} else {
			Object.assign(fallbackSignerWindowEthereum, this.createInterceptorProvider(fallbackSignerWindowEthereum))
		}
		this.installControlledAccountCompatibilityProperties()
		this.connectToSigner(fallbackSignerName)
	}
}

function injectInterceptor() {
	const interceptorMessageListener = new InterceptorMessageListener()
	window.addEventListener('message', interceptorMessageListener.onWindowMessage)

	// keep listening for other wallets that announce themselves and reinject without patching dispatchEvent
	const onEthereumInitialized = () => {
		if (inpageWindow.ethereum?.isInterceptor) return
		interceptorMessageListener.injectEthereumIntoWindow()
	}
	window.addEventListener('ethereum#initialized', onEthereumInitialized)
	window.dispatchEvent(new Event('ethereum#initialized'))
}

injectInterceptor()
