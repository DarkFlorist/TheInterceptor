import { generateUuidV4, isUuid } from '../../ts/utils/uuid.js'
import { INTERCEPTOR_BRIDGE_REQUEST_MESSAGE, INTERCEPTOR_BRIDGE_INITIALIZED_MESSAGE, INTERCEPTOR_BRIDGE_RECONNECTED_MESSAGE, installInpageBridgeInitializer } from '../../ts/utils/inpageBridgeProtocol.js'
import { isInternalProviderMethod as isInternalBackgroundMethod } from '../../ts/utils/internalProviderMethods.js'
import { createSignerProviderCoordinator } from './signerProviderCoordinator.js'
import { createPrivateInpageBridge } from './privateInpageBridge.js'
import type { InternalProviderMethod } from '../../ts/utils/internalProviderMethods.js'
import type { EIP6963ProviderInfo } from '../../ts/utils/eip6963ProviderInfo.js'
import type { SignerName } from '../../ts/types/signerTypes.js'

const SAFE_APPS_RESPONSE_VERSION = '9.1.0'
const SAFE_APPS_PENDING_REQUEST_LIMIT = 32

type SafeAppsWindow = {
	readonly location: { readonly origin: string }
	addEventListener(type: 'message', listener: (event: Event) => void): void
	removeEventListener(type: 'message', listener: (event: Event) => void): void
	postMessage(message: unknown, targetOrigin: string): void
}

type SafeAppsRequest = {
	readonly id: string
	readonly method: string
	readonly params?: unknown
}

type ParsedSafeAppsRequest =
	| { readonly id: string, readonly request: SafeAppsRequest }
	| { readonly id: string, readonly error: string }

type SafeAppsMessageEvent = { readonly data: unknown, readonly origin: string, readonly source: unknown }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

type SafeAppsRequestCandidate = { readonly id?: unknown, readonly method?: unknown, readonly env?: unknown, readonly params?: unknown }
type SafeAppsEnvironmentCandidate = { readonly sdkVersion?: unknown }
type SafeAppsCompatibilityCandidate = { readonly enabled?: unknown, readonly canRequestAccess?: unknown }
type SafeAppsCommandCandidate = { readonly kind?: unknown, readonly value?: unknown, readonly method?: unknown, readonly params?: unknown, readonly mapResult?: unknown, readonly message?: unknown, readonly isTypedData?: unknown, readonly safeAddress?: unknown, readonly chainId?: unknown, readonly safeRequestContext?: unknown }

const isSafeAppsRequestCandidate = (value: unknown): value is SafeAppsRequestCandidate => isRecord(value)
const isSafeAppsEnvironmentCandidate = (value: unknown): value is SafeAppsEnvironmentCandidate => isRecord(value)
const isSafeAppsCompatibilityCandidate = (value: unknown): value is SafeAppsCompatibilityCandidate => isRecord(value)
const isSafeAppsCommandCandidate = (value: unknown): value is SafeAppsCommandCandidate => isRecord(value)

function parseSafeAppsMessageEvent(event: Event): SafeAppsMessageEvent | undefined {
	if (!('data' in event) || !('origin' in event) || !('source' in event) || typeof event.origin !== 'string') return undefined
	return { data: event.data, origin: event.origin, source: event.source }
}

function parseSafeAppsRequest(data: unknown): ParsedSafeAppsRequest | undefined {
	if (!isSafeAppsRequestCandidate(data) || typeof data.id !== 'string') return undefined
	// The SDK envelope distinguishes Safe Apps requests from unrelated page postMessage protocols.
	if (!isSafeAppsEnvironmentCandidate(data.env)) return undefined
	if (typeof data.env.sdkVersion !== 'string' || !/^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(data.env.sdkVersion)) {
		return { id: data.id, error: 'Safe Apps env.sdkVersion must be a supported semantic version.' }
	}
	if (typeof data.method !== 'string') return { id: data.id, error: 'Safe Apps method must be a string.' }
	return { id: data.id, request: { id: data.id, method: data.method, ...(data.params === undefined ? {} : { params: data.params }) } }
}

function parseSafeAppsCompatibility(value: unknown) {
	if (!isSafeAppsCompatibilityCandidate(value) || typeof value.enabled !== 'boolean') return undefined
	if (value.canRequestAccess !== undefined && typeof value.canRequestAccess !== 'boolean') return undefined
	return { enabled: value.enabled, canRequestAccess: value.canRequestAccess === true }
}

async function executeSafeAppsCommand(command: unknown, requestEthereum: EthereumRequest, requestSafeApps: (request: Pick<SafeAppsRequest, 'method' | 'params'>) => Promise<unknown>): Promise<unknown> {
	if (!isSafeAppsCommandCandidate(command) || (command.kind !== 'result' && command.kind !== 'ethereumRequest')) throw new Error('Interceptor returned an invalid Safe Apps command.')
	if (command.kind === 'result') return command.value
	if (typeof command.method !== 'string' || !Array.isArray(command.params) || (command.mapResult !== 'passthrough' && command.mapResult !== 'safeTxHash' && command.mapResult !== 'safeMessage')) throw new Error('Interceptor returned an invalid Safe Apps Ethereum request.')
	if (command.mapResult === 'safeMessage' && (typeof command.message !== 'string' || typeof command.safeAddress !== 'string' || typeof command.chainId !== 'string')) throw new Error('Interceptor returned an invalid Safe message request.')
	const result = command.safeRequestContext === undefined
		? await requestEthereum({ method: command.method, params: command.params })
		: await requestSafeApps({ method: 'execute', params: command })
	if (command.mapResult === 'passthrough') return result
	if (command.mapResult === 'safeMessage') {
		if (typeof result !== 'string' || !/^0x[0-9a-f]{130}$/i.test(result)) throw new Error('Interceptor returned an invalid Safe owner signature.')
		const submitted = await requestSafeApps({ method: 'submitOffChainMessage', params: { message: command.message, signature: result, safeAddress: command.safeAddress, chainId: command.chainId, ...(command.isTypedData === true ? { isTypedData: true } : {}) } })
		if (!isSafeAppsCommandCandidate(submitted) || submitted.kind !== 'result') throw new Error('Interceptor returned an invalid Safe message submission response.')
		return submitted.value
	}
	if (typeof result !== 'string') throw new Error('Interceptor returned an invalid transaction hash.')
	return { safeTxHash: result }
}

// Retain read-only discovery while ineligible and reissue it after eligibility changes so stale account data is never published.
const isSafeAppsDiscoveryRequest = (request: ParsedSafeAppsRequest) => 'request' in request && (request.request.method === 'getSafeInfo' || request.request.method === 'getChainInfo' || request.request.method === 'getEnvironmentInfo')

function createSafeAppsRequestHandler(requestBackground: (request: unknown) => Promise<unknown>, requestEthereum: EthereumRequest) {
	let offChainSigning = true
	return async (request: Pick<SafeAppsRequest, 'method' | 'params'>) => {
		const signingRequest = request.method === 'signMessage' || request.method === 'signTypedMessage'
		const command = await requestBackground({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }), ...(signingRequest ? { offChainSigning } : {}) })
		const result = await executeSafeAppsCommand(command, requestEthereum, requestBackground)
		if (request.method === 'rpcCall' && isRecord(request.params)) {
			const { call } = request.params
			if (call === 'safe_setSettings') {
				if (!isRecord(result)) throw new Error('Interceptor returned invalid Safe Apps settings.')
				const { offChainSigning: updated } = result
				if (typeof updated !== 'boolean') throw new Error('Interceptor returned invalid Safe Apps settings.')
				offChainSigning = updated
			}
		}
		return result
	}
}

function createSafeAppsBridge(windowObject: SafeAppsWindow, requestSafeApps: (request: Pick<SafeAppsRequest, 'method' | 'params'>) => Promise<unknown>, requestAccess: () => Promise<void>) {
	let enabled = false
	let enablementGeneration = 0
	let canRequestAccess = false
	let accessRequested = false
	let accessFailure: string | undefined
	const pendingRequests: { readonly parsedRequest: ParsedSafeAppsRequest, readonly origin: string }[] = []
	const answerRequest = (parsedRequest: ParsedSafeAppsRequest, origin: string) => {
		if ('error' in parsedRequest) {
			windowObject.postMessage({ id: parsedRequest.id, success: false, error: parsedRequest.error, version: SAFE_APPS_RESPONSE_VERSION }, origin)
			return
		}
		const request = parsedRequest.request
		const requestEnablementGeneration = enablementGeneration
		const isCurrentResponse = () => {
			if (enabled && requestEnablementGeneration === enablementGeneration) return true
			// Startup queries must survive a temporary loss of eligibility, but their old account data must never be published.
			if (isSafeAppsDiscoveryRequest(parsedRequest)) {
				if (enabled) answerRequest(parsedRequest, origin)
				else if (pendingRequests.length < SAFE_APPS_PENDING_REQUEST_LIMIT) {
					pendingRequests.push({ parsedRequest, origin })
					requestAccessForDiscovery()
				}
			}
			return false
		}
		void requestSafeApps(request).then(
			(data) => {
				if (!isCurrentResponse()) return
				windowObject.postMessage({ id: request.id, success: true, data, version: SAFE_APPS_RESPONSE_VERSION }, origin)
			},
			(error: unknown) => {
				if (!isCurrentResponse()) return
				windowObject.postMessage({ id: request.id, success: false, error: error instanceof Error ? error.message : 'Safe Apps request failed.', version: SAFE_APPS_RESPONSE_VERSION }, origin)
			},
		)
	}
	const rejectPendingDiscovery = (message: string) => {
		for (const { parsedRequest, origin } of pendingRequests.splice(0)) {
			windowObject.postMessage({ id: parsedRequest.id, success: false, error: message, version: SAFE_APPS_RESPONSE_VERSION }, origin)
		}
	}
	const requestAccessForDiscovery = () => {
		if (enabled || !canRequestAccess || !pendingRequests.some(({ parsedRequest }) => isSafeAppsDiscoveryRequest(parsedRequest))) return
		if (accessFailure !== undefined) {
			rejectPendingDiscovery(accessFailure)
			return
		}
		if (accessRequested) return
		accessRequested = true
		void requestAccess().catch((error: unknown) => {
			accessFailure = error instanceof Error ? error.message : 'Safe Apps connection failed.'
			if (!canRequestAccess || enabled) return
			rejectPendingDiscovery(accessFailure)
		})
	}
	const onMessage = (event: Event) => {
		const messageEvent = parseSafeAppsMessageEvent(event)
		if (messageEvent === undefined) return
		if (messageEvent.source !== windowObject || messageEvent.origin !== windowObject.location.origin) return
		const parsedRequest = parseSafeAppsRequest(messageEvent.data)
		if (parsedRequest === undefined) return
		if (!enabled && isSafeAppsDiscoveryRequest(parsedRequest)) {
			if (pendingRequests.length >= SAFE_APPS_PENDING_REQUEST_LIMIT) {
				if (enabled === false && !canRequestAccess) return
				windowObject.postMessage({ id: parsedRequest.id, success: false, error: 'Interceptor Safe Apps request queue is full. Retry after the connection finishes initializing.', version: SAFE_APPS_RESPONSE_VERSION }, messageEvent.origin)
				return
			}
			pendingRequests.push({ parsedRequest, origin: messageEvent.origin })
			requestAccessForDiscovery()
			return
		}
		if (enabled) answerRequest(parsedRequest, messageEvent.origin)
	}
	windowObject.addEventListener('message', onMessage)
	return {
		setEnabled(nextEnabled: boolean, nextCanRequestAccess = false) {
			canRequestAccess = nextCanRequestAccess
			if (enabled !== nextEnabled) enablementGeneration += 1
			enabled = nextEnabled
			const queuedRequests = pendingRequests.splice(0)
			if (nextEnabled) {
				for (const { parsedRequest, origin } of queuedRequests) answerRequest(parsedRequest, origin)
			} else {
				// Never defer signing or transaction requests across a disabled state.
				pendingRequests.push(...queuedRequests.filter(({ parsedRequest }) => isSafeAppsDiscoveryRequest(parsedRequest)))
				requestAccessForDiscovery()
			}
		},
		dispose() {
			pendingRequests.splice(0)
			windowObject.removeEventListener('message', onMessage)
		},
	}
}

const METAMASK_ERROR_USER_REJECTED_REQUEST = 4001
const METAMASK_ERROR_PROVIDER_DISCONNECTED = 4900
const METAMASK_ERROR_BLANKET_ERROR = -32603
const METAMASK_METHOD_NOT_SUPPORTED = -32004
const METAMASK_INVALID_METHOD_PARAMS = -32602
const SIGNER_DISCOVERY_TIMEOUT_MS = 3000
const SIGNER_DISCOVERY_RETRY_INTERVAL_MS = 100

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

export type MessageMethodAndParams = {
	readonly method: string,
	readonly params?: readonly unknown[]
}

type InterceptedRequestBase = {
	readonly walletSwitchRequestId?: string,
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

const REQUEST_SCOPED_PROVIDER_EVENT_METHODS = new Set(['accountsChanged', 'connect', 'disconnect', 'chainChanged'])
class SignerSynchronizationBridgeReconnectedError extends Error {}

function normalizeSignerChainId(chainId: string) {
	// Coinbase historically emitted decimal chain IDs. Only normalize the entire value so malformed IDs are not silently truncated by Number.parseInt.
	return /^[0-9]+$/.test(chainId) ? `0x${ BigInt(chainId).toString(16) }` : chainId
}

function chainIdToNetworkVersion(chainId: string) {
	return BigInt(chainId).toString(10)
}

type InterceptorApprovedMessageCandidate = {
	readonly walletSwitchRequestId?: unknown
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
	readonly bridgeCapability: string
	readonly method: string
	readonly params?: readonly unknown[]
	readonly usingInterceptorWithoutSigner: boolean
	readonly requestId: number
	readonly internal?: true
	readonly replayOnDisconnect?: true
}

const isMessageCandidate = (value: unknown): value is InterceptorApprovedMessageCandidate => typeof value === 'object' && value !== null
const isErrorCandidate = (value: unknown): value is InterceptorErrorCandidate => typeof value === 'object' && value !== null
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
		...(typeof data.walletSwitchRequestId === 'string' ? { walletSwitchRequestId: data.walletSwitchRequestId } : {}),
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
type LegacyJsonRpcCallback = (error: Error | null, response: JsonRpcResponse | JsonRpcResponse[] | null) => void

type SignerAccountsReply =
	| { readonly type: 'success', readonly accounts: readonly string[], readonly requestAccounts: boolean }
	| { readonly type: 'error', readonly error: { readonly code: number, readonly message: string, readonly data?: unknown }, readonly requestAccounts: boolean, readonly signerUnavailable?: true }

type SignerAccountsResolution = {
	readonly signerProviderGeneration: number
	readonly reply: SignerAccountsReply
}

type SignerProviderRequestOutcome =
	| { readonly type: 'success', readonly reply: unknown, readonly signerProviderGeneration: number }
	| { readonly type: 'error', readonly error: unknown, readonly signerProviderGeneration: number }
	| { readonly type: 'providerChanged', readonly signerProviderGeneration: number }

type SignerWalletReply<ForwardRequest> = {
	readonly forwardRequest: ForwardRequest
	readonly signerProviderGeneration: number
} & (
	| { readonly success: true, readonly reply: unknown }
	| { readonly success: false, readonly error: { readonly code: number, readonly message: string, readonly data?: unknown } }
)

type AnyCallBack =  ((message: ProviderMessage) => void)
	| ((connectInfo: ProviderConnectInfo) => void)
	| ((accounts: readonly string[]) => void)
	| ((error: ProviderRpcError) => void)
	| ((chainId: string) => void)

type EthereumRequestParameters = readonly unknown[] | Readonly<Record<string, unknown>>
type EthereumRequest = (methodAndParams: { readonly method: string, readonly params?: EthereumRequestParameters }) => Promise<unknown>
type InterceptorEthereumRequestParameters = EthereumRequestParameters
const METHODS_ACCEPTING_NAMED_PARAMETERS: ReadonlySet<string> = new Set(['wallet_watchAsset'])

function normalizeInterceptorEthereumRequestParameters(method: string, params: InterceptorEthereumRequestParameters | undefined): readonly unknown[] | undefined {
	if (params === undefined || Array.isArray(params)) return params
	if (!METHODS_ACCEPTING_NAMED_PARAMETERS.has(method)) throw new EthereumJsonRpcError(METAMASK_INVALID_METHOD_PARAMS, `Named parameters are not supported for ${ method }.`)
	return [params]
}

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

export type WindowEthereum = InjectFunctions & {
	isAmbire?: boolean,
	isBraveWallet?: boolean,
	isMetaMask?: boolean,
	isRabby?: boolean,
	isInterceptor?: boolean,
	providerMap?: Map<string, WindowEthereum>, // coinbase does not inject `isCoinbaseWallet` to the window.ethereum if there's already other wallets present (eg, Interceptor or Metamask), but instead injects a provider map that contains all these providers
	providers?: readonly WindowEthereum[],
	isCoinbaseWallet?: boolean,

	// for metamask compatibility mode
	selectedAddress?: string | null,
	chainId?: string,
	networkVersion?: string,
}

type LegacyWeb3 = {
	currentProvider?: WindowEthereum
	accounts?: readonly string[]
}

type InpageWindow = Window & {
	ethereum?: WindowEthereum
	web3?: LegacyWeb3
}

const inpageWindow: InpageWindow = window

type SingleSendAsyncParam = { readonly id: string | number | null, readonly method: string, readonly params: InterceptorEthereumRequestParameters }
type ForwardedDiagnosticsRequestContext = {
	readonly requestId?: number
	readonly requestMethod?: string
}

type OutstandingRequest = {
	readonly future: InterceptorFuture<unknown>
	readonly method: string
	requestScopedProviderEventCallbacks?: (() => void)[]
}

// Queries and filter/subscription operations have no durable approval or replay path. Reject them on reconnect without replaying potentially state-changing operations, so lost replies release their selection blockers. Wallet commands and account approvals keep their existing recovery workflows.
const PUBLIC_QUERIES_INTERRUPTED_BY_RECONNECT = new Set([
	'eth_accounts',
	'eth_blockNumber',
	'eth_call',
	'eth_chainId',
	'eth_estimateGas',
	'eth_feeHistory',
	'eth_gasPrice',
	'eth_getBalance',
	'eth_getBlockByHash',
	'eth_getBlockByNumber',
	'eth_getCode',
	'eth_getFilterChanges',
	'eth_getFilterLogs',
	'eth_getLogs',
	'eth_getStorageAt',
	'eth_getTransactionByHash',
	'eth_getTransactionCount',
	'eth_getTransactionReceipt',
	'eth_maxPriorityFeePerGas',
	'eth_newFilter',
	'eth_simulateV1',
	'eth_subscribe',
	'eth_uninstallFilter',
	'eth_unsubscribe',
	'interceptor_getSimulationStack',
	'net_version',
	'wallet_getCapabilities',
	'wallet_getPermissions',
	'web3_clientVersion',
])

type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'
export type Signer = SignerName

function getSignerNameFromWalletMarkers(markers: { readonly isAmbire: boolean, readonly isBrave: boolean, readonly isCoinbase: boolean, readonly isMetaMask: boolean, readonly isRabby: boolean }): Signer {
	if (markers.isCoinbase) return 'CoinbaseWallet'
	if (markers.isAmbire) return 'Ambire'
	if (markers.isBrave) return 'Brave'
	if (markers.isRabby) return 'Rabby'
	if (markers.isMetaMask) return 'MetaMask'
	return 'NotRecognizedSigner'
}

function isForwardedDiagnosticsRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function stringifyForwardedFallbackError(error: unknown) {
	try {
		if (error instanceof Error) return `${ error.name }: ${ error.message }`
		return `Unexpected thrown value: ${ String(error) }`
	} catch {
		return 'Unexpected thrown value: [unprintable error]'
	}
}

function stringifyForwardedFallbackValue(value: unknown) {
	try {
		return String(value)
	} catch (error: unknown) {
		return `[failed to stringify value: ${ stringifyForwardedFallbackError(error) }]`
	}
}

function stringifyForwardedThrownValue(value: unknown) {
	try {
		if (value instanceof Error) return value.stack ?? `${ value.name }: ${ value.message }`
		if (typeof value === 'bigint') return value.toString()
		const stringified = JSON.stringify(value, (_key: string, nestedValue: unknown) => typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue)
		if (stringified !== undefined) return stringified
	} catch (error: unknown) {
		const fallbackValue = stringifyForwardedFallbackValue(value)
		return `${ fallbackValue }\n\n[serialization fallback: ${ stringifyForwardedFallbackError(error) }]`
	}
	return stringifyForwardedFallbackValue(value)
}

function getForwardedDiagnosticsSummary(error: unknown) {
	try {
		if (error instanceof Error) return error.message
		if (typeof error === 'string') return error
		if (error === undefined) return 'Unexpected thrown value: undefined'
		if (error === null) return 'Unexpected thrown value: null'
		if (isForwardedDiagnosticsRecord(error)) {
			const { message } = error
			if (typeof message === 'string') return message
		}
		return String(error)
	} catch (summaryError: unknown) {
		return `Failed to read thrown-value summary: ${ stringifyForwardedFallbackError(summaryError) }`
	}
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

function getLegacyWeb3WithoutInvokingAccessors(target: InpageWindow): LegacyWeb3 | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(target, 'web3')
	if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'object' || descriptor.value === null) return undefined
	if (Object.getOwnPropertyDescriptor(descriptor.value, '__isMetaMaskShim__')?.value === true) return undefined
	return descriptor.value
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
			&& 'removeListener' in provider
			&& typeof provider.removeListener === 'function'
	}
	private static readonly hasUsableSignerInterface = (provider: unknown): provider is WindowEthereum => {
		return InterceptorMessageListener.hasRequestAndOn(provider)
			&& (provider.isConnected === undefined || typeof provider.isConnected === 'function')
	}
	private static readonly hasNoConflictingWalletMarkers = (provider: WindowEthereum) => {
		return (provider.isMetaMask === undefined || provider.isMetaMask === true)
			&& (provider.isAmbire === undefined || provider.isAmbire === false)
			&& (provider.isBraveWallet === undefined || provider.isBraveWallet === false)
			&& (provider.isCoinbaseWallet === undefined || provider.isCoinbaseWallet === false)
			&& (provider.isRabby === undefined || provider.isRabby === false)
			&& (provider.isInterceptor === undefined || provider.isInterceptor === false)
	}

	private connected = false
	private signerName: Signer = 'NoSigner'
	private requestId = 0
	private metamaskCompatibilityMode = false
	// The page owns SDK settings; every signing request carries its mode across background port recreation.
	private readonly safeAppsBridge = createSafeAppsBridge(inpageWindow, createSafeAppsRequestHandler(
		async (request) => await this.sendInternalMessageToBackgroundPage({ method: 'safe_apps_request', params: [request] }),
		async (request) => await this.WindowEthereumRequest(request),
	), async () => {
		// Restore persisted access after reload before considering an interactive wallet connection.
		const accounts = await this.WindowEthereumRequest({ method: 'eth_accounts' })
		if (!Array.isArray(accounts) || accounts.length === 0) await this.WindowEthereumRequest({ method: 'eth_requestAccounts' })
		// Recheck Safe eligibility after the ordinary wallet/site approval flow completes.
		await this.sendInternalMessageToBackgroundPage({ method: 'safe_apps_request', params: [{ method: 'getEnvironmentInfo' }] })
	})
	private signerWindowEthereumProvider: WindowEthereum | undefined = undefined
	private signerWindowEthereumRequest: EthereumRequest | undefined = undefined
	private fallbackSignerWindowEthereumRequest: EthereumRequest | undefined = undefined
	private readonly privateBridge: ReturnType<typeof createPrivateInpageBridge>
	private readonly bridgeCapability = generateUuidV4()
	private readonly pendingBridgeDiagnostics: string[] = []
	private contentScriptCapability: string | undefined = undefined
	private readonly contentScriptBridgeInitialized = new InterceptorFuture<void>()
	private readonly subscribedSignerProviders = new WeakSet<object>()
	private readonly preparedSignerTransports = (() => {
		const transports = new WeakMap<WindowEthereum, { readonly request: EthereumRequest, readonly isConnected: () => boolean }>()
		// Bind native cache operations at document_start so later page prototype hooks cannot recover the original wallet request.
		return { get: transports.get.bind(transports), set: transports.set.bind(transports) }
	})()
	private signerSelectionGeneration = 0
	private readonly initialSignerProviderCatalogReconciliation = new InterceptorFuture<void>()
	private initialSignerProviderCatalogReconciled = false
	private signerProviderGeneration = 0
	private latestSignerConnectionTransition: Promise<void> = Promise.resolve()
	private readonly signerConnectionTransitionChangeWaiters = new Set<InterceptorFuture<void>>()
	private readonly signerProviderChangeWaiters = new Set<InterceptorFuture<void>>()
	private readonly signerAvailabilityWaiters = new Set<InterceptorFuture<void>>()
	private signerDiscoveryRetryTimer: ReturnType<typeof setTimeout> | undefined = undefined

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
	private pendingSignerAddressRequest: Promise<SignerAccountsResolution> | undefined = undefined

	private readonly signerProviders: ReturnType<typeof createSignerProviderCoordinator>

	public constructor() {
		this.signerProviders = createSignerProviderCoordinator({
			activateAnnouncedSigner: (provider: unknown) => {
				const prepared = this.prepareSignerProvider(provider, 'EIP6963', false, false)
				if (prepared === undefined) return false
				this.setSignerProvider(prepared.provider, prepared.request)
				this.connected = prepared.connected
				return true
			},
			clearSigner: () => { this.setSignerProvider(undefined, undefined); this.connected = true },
			hasUsableSignerInterface: InterceptorMessageListener.hasUsableSignerInterface,
			completeSelection: async (info, kind) => {
				await this.sendInternalMessageToBackgroundPage({ method: 'signer_provider_selected', params: [info, kind] })
				await this.connectToSigner('EIP6963')
				await this.getAccountsFromSigner()
			},
			isBridgeReconnectedError: (error) => error instanceof SignerSynchronizationBridgeReconnectedError,
			connectToSigner: (...args) => this.connectToSigner(...args),
			recoverSignerConnection: async () => {
				await this.connectToSigner(this.signerName, true)
				await this.getAccountsFromSigner()
			},
			invalidateSignerConnection: () => { this.advanceSignerProviderGeneration() },
			markInitialSignerProviderCatalogReconciled: (...args) => this.markInitialSignerProviderCatalogReconciled(...args),
			reportSignerDiscoveryError: (...args) => this.reportSignerDiscoveryError(...args),
			sendInternalMessageToBackgroundPage: (...args) => this.sendInternalMessageToBackgroundPage(...args),
		})
		this.privateBridge = createPrivateInpageBridge(this.bridgeCapability, (event) => { void this.onMessage(event) })
		this.injectEthereumIntoWindow()
		this.onPageLoad()
	}

	public readonly initializeBridge = (secret: string) => {
		const accepted = this.privateBridge.offerPort(secret)
		return accepted
	}

	private readonly WindowEthereumIsConnected = () => this.connected

	private readonly getControlledSelectedAddress = () => this.currentAddress === '' ? undefined : this.currentAddress

	private readonly getControlledAccounts = () => this.currentAddress === '' ? [] : [this.currentAddress]

	private readonly refreshAccountCompatibilityProperties = (accounts: readonly string[]) => {
		const address = accounts[0] ?? ''
		if (this.metamaskCompatibilityMode && inpageWindow.ethereum !== undefined && !this.ethereumSelectedAddressControlled) {
			setCompatibilityProperty(inpageWindow.ethereum, 'selectedAddress', address, 'window.ethereum.selectedAddress')
		}
		const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
		if (this.metamaskCompatibilityMode && legacyWeb3 !== undefined && !this.web3AccountsControlled) {
			setCompatibilityProperty(legacyWeb3, 'accounts', accounts, 'window.web3.accounts')
		}
	}

	private readonly hasNonConfigurableAccountCompatibilityProperty = () => {
		if (inpageWindow.ethereum !== undefined && Object.getOwnPropertyDescriptor(inpageWindow.ethereum, 'selectedAddress')?.configurable === false) return true
		const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
		if (legacyWeb3 !== undefined && Object.getOwnPropertyDescriptor(legacyWeb3, 'accounts')?.configurable === false) return true
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
		const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
		if (legacyWeb3 !== undefined) {
			if (Object.getOwnPropertyDescriptor(legacyWeb3, 'accounts')?.configurable === false) {
				setCompatibilityProperty(inpageWindow, 'web3', { accounts: this.getControlledAccounts(), currentProvider: inpageWindow.ethereum as WindowEthereum }, 'window.web3')
			}
			const controlledLegacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (controlledLegacyWeb3 === undefined) return
			this.web3AccountsControlled = this.installControlledCompatibilityProperty(controlledLegacyWeb3, 'accounts', this.getControlledAccounts, 'window.web3.accounts')
			setCompatibilityProperty(controlledLegacyWeb3, 'currentProvider', inpageWindow.ethereum as WindowEthereum, 'window.web3.currentProvider')
		}
	}

	private readonly sendMessageToBackgroundPage = async (request: MessageMethodAndParams, internal = false, pendingSignerReply?: SignerWalletReply<unknown>) => {
		if (!internal) {
			if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
			// Startup can request another signer status handshake as the initial catalog settles. Wait for its identity before the background captures a request token.
			for (;;) {
				await this.waitForLatestSignerConnectionTransition()
				if (!this.signerProviders.isRecoveringSignerConnection()) break
				await this.signerProviders.waitForSignerConnectionRecovery()
			}
		}
		await this.contentScriptBridgeInitialized
		if (pendingSignerReply !== undefined) {
			while (this.signerProviders.isRecoveringSignerConnection()) await this.signerProviders.waitForSignerConnectionRecovery()
		}
		// No await may separate this epoch check from dispatch: another recovery can invalidate a completed wallet result.
		const messageMethodAndParams = pendingSignerReply === undefined ? request : { method: 'signer_reply', params: [this.checkSignerReplyGeneration(pendingSignerReply)] }
		this.requestId++
		const pendingRequestId = this.requestId
		const blocksSignerSelection = !internal
		const releaseSelectionBlocker = blocksSignerSelection ? this.signerProviders.blockSignerSelection() : undefined
		const replayOnDisconnect = !internal && messageMethodAndParams.method === 'eth_requestAccounts'
		const future = new InterceptorFuture<unknown>()
		this.outstandingRequests.set(pendingRequestId, {
			future,
			method: messageMethodAndParams.method,
			requestScopedProviderEventCallbacks: [],
		})
		try {
			const message: BridgeRequest = {
				type: INTERCEPTOR_BRIDGE_REQUEST_MESSAGE,
				bridgeCapability: this.bridgeCapability,
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
				usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
				requestId: pendingRequestId,
				internal: internal ? true : undefined,
				...(replayOnDisconnect ? { replayOnDisconnect: true as const } : {}),
			}
			this.privateBridge.postMessage(message)
			return await future
		} finally {
			this.outstandingRequests.delete(pendingRequestId)
			releaseSelectionBlocker?.()
		}
	}

	private readonly markInitialSignerProviderCatalogReconciled = () => {
		if (this.initialSignerProviderCatalogReconciled) return
		this.initialSignerProviderCatalogReconciled = true
		this.initialSignerProviderCatalogReconciliation.resolve(undefined)
	}

	private readonly startSignerSelectionBlockingWorkflow = (phase: string, workflow: () => Promise<unknown>) => {
		void this.signerProviders.runWithSignerSelectionBlocked(workflow).catch((error: unknown) => {
			this.reportSignerDiscoveryError(phase, error)
		})
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

	private readonly sendInternalMessageToBackgroundPage = async (messageMethodAndParams: { readonly method: InternalProviderMethod, readonly params?: readonly unknown[] }) => {
		return await this.sendMessageToBackgroundPage(messageMethodAndParams, true)
	}

	private readonly checkSignerReplyGeneration = <ForwardRequest>(reply: SignerWalletReply<ForwardRequest>): SignerWalletReply<ForwardRequest> => reply.signerProviderGeneration === this.signerProviderGeneration ? reply : {
		success: false,
		forwardRequest: reply.forwardRequest,
		error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet reply could be delivered.' },
		signerProviderGeneration: reply.signerProviderGeneration,
	}

	private readonly sendSignerReplyToBackgroundPage = async <ForwardRequest>(reply: SignerWalletReply<ForwardRequest>) => {
		// Signing confirmations and watch-asset workflows own their terminal errors; admission happens at transport dispatch.
		return await this.sendMessageToBackgroundPage({ method: 'signer_reply' }, true, reply)
	}

	private readonly reportInterceptorError = (diagnostics: string) => {
		try {
			if (this.contentScriptCapability === undefined) {
				if (this.pendingBridgeDiagnostics.length < 16) this.pendingBridgeDiagnostics.push(diagnostics)
				return
			}
			const message: BridgeRequest = {
				type: INTERCEPTOR_BRIDGE_REQUEST_MESSAGE,
				bridgeCapability: this.bridgeCapability,
				method: 'InterceptorError',
				params: [diagnostics],
				usingInterceptorWithoutSigner: this.signerWindowEthereumRequest === undefined,
				requestId: -1,
				internal: true,
			}
			this.privateBridge.postMessage(message)
		} catch(reportingError: unknown) {
			console.error('Failed to report InterceptorError diagnostics')
			console.error(reportingError)
		}
	}

	private readonly reportSignerDiscoveryError = (phase: string, error: unknown) => {
		if (error instanceof SignerSynchronizationBridgeReconnectedError) return
		this.reportInterceptorError(serializeForwardedDiagnostics('inpage', phase, error))
	}

	// sends a message to interceptors background script
	private readonly WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: InterceptorEthereumRequestParameters }) => {
		try {
			// Snapshot page-owned accessors before validation; transport authority is a separate private argument.
			const { method, params: suppliedParams } = methodAndParams
			if (isInternalBackgroundMethod(method)) throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, `Method not supported: ${ method }`)
			const params = normalizeInterceptorEthereumRequestParameters(method, suppliedParams)
			// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
			return await this.sendMessageToBackgroundPage({
				method,
				...(params !== undefined ? { params } : {}),
			})
		} catch (error: unknown) {
			if (error instanceof Error) throw error
			throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { error: error, request: methodAndParams })
		}
	}

	private readonly requestFromSigner = async (methodAndParams: { readonly method: string, readonly params?: EthereumRequestParameters }, allowRequestAccountsFallbackToRoot = false) => {
		if (this.signerWindowEthereumRequest === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
		const releaseSelectionBlocker = this.signerProviders.blockSignerSelection()
		try {
			try {
				return await this.signerWindowEthereumRequest(methodAndParams)
			} catch (error: unknown) {
				if (!allowRequestAccountsFallbackToRoot || this.fallbackSignerWindowEthereumRequest === undefined) throw error
				if (methodAndParams.method === 'eth_accounts') throw error
				if (!canFallbackRequestToRootSigner(methodAndParams.method)) throw error
				if (InterceptorMessageListener.isUserRejectedRequestError(error)) throw error
				return await this.fallbackSignerWindowEthereumRequest(methodAndParams)
			}
		} finally {
			releaseSelectionBlocker()
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
				this.startSignerSelectionBlockingWorkflow('report signer accountsChanged event', async () => {
					if (this.signerWindowEthereumProvider !== provider) return
					if (!Array.isArray(accounts)) return
					if (!InterceptorMessageListener.isStringArray([...accounts])) return
					this.signerAccounts = [...accounts]
					if (this.pendingSignerAddressRequest !== undefined) return
					await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: this.signerAccounts, requestAccounts: false, signerProviderGeneration: this.signerProviderGeneration }] })
				})
			})
			register('connect', (_connectInfo: ProviderConnectInfo) => {
				this.startSignerSelectionBlockingWorkflow('report signer connect event', async () => {
					if (this.signerWindowEthereumProvider !== provider) return
					await this.connectToSigner(signerName)
				})
			})
			register('disconnect', (_error: ProviderRpcError) => {
				this.startSignerSelectionBlockingWorkflow('report signer disconnect event', async () => {
					if (this.signerWindowEthereumProvider !== provider) return
					const signerProviderGeneration = this.advanceSignerProviderGeneration()
					await this.sendInternalMessageToBackgroundPage({ method: 'connected_to_signer', params: [false, signerName, signerProviderGeneration] })
				})
			})
			register('chainChanged', (chainId: string) => {
				this.startSignerSelectionBlockingWorkflow('report signer chainChanged event', async () => {
					if (this.signerWindowEthereumProvider !== provider) return
					const params = [normalizeSignerChainId(chainId), this.signerProviderGeneration]
					await this.sendInternalMessageToBackgroundPage({ method: 'signer_chainChanged', params })
				})
			})
			this.subscribedSignerProviders.add(provider)
		} catch (error: unknown) {
			this.signerProviders.rejectProvider(provider)
			for (const registration of registrations.reverse()) {
				try {
					signerRemoveListener(registration.kind, registration.callback)
				} catch (rollbackError: unknown) {
					this.signerProviders.rejectProvider(provider)
					this.reportSignerDiscoveryError('roll back signer event subscription', rollbackError)
				}
			}
			throw error
		}
	}

	private readonly trySubscribeToSignerEvents = (provider: WindowEthereum, signerName: Signer, signerOn = provider.on.bind(provider), signerRemoveListener = provider.removeListener.bind(provider)) => {
		if (this.signerProviders.isProviderRejected(provider)) return false
		try {
			this.subscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)
			return true
		} catch (error: unknown) {
			this.reportSignerDiscoveryError('subscribe to signer events', error)
			return false
		}
	}

	private readonly prepareSignerProvider = (provider: unknown, signerName: Signer, requireMetaMaskMarker = false, requireMetaMaskConsistency = true) => {
		try {
			if (!InterceptorMessageListener.hasUsableSignerInterface(provider)) return undefined
			if (this.signerProviders.isProviderRejected(provider)) return undefined
			if (requireMetaMaskMarker && provider.isMetaMask !== true) return undefined
			if (requireMetaMaskConsistency && !InterceptorMessageListener.hasNoConflictingWalletMarkers(provider)) return undefined
			// Legacy roots may be patched in place. Keep their original bound transport across selections, but read connection state afresh.
			const preparedTransport = this.preparedSignerTransports.get(provider)
			if (preparedTransport !== undefined) return { provider, connected: preparedTransport.isConnected(), request: preparedTransport.request }
			const request = provider.request.bind(provider)
			const signerOn = provider.on.bind(provider)
			const signerRemoveListener = provider.removeListener.bind(provider)
			const isConnected = provider.isConnected?.bind(provider) ?? (() => true)
			const connected = isConnected()
			if (!this.trySubscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)) return undefined
			this.preparedSignerTransports.set(provider, { request, isConnected })
			return { provider, connected, request }
		} catch (error: unknown) {
			if (typeof provider === 'object' && provider !== null) this.signerProviders.rejectProvider(provider)
			this.reportSignerDiscoveryError('prepare signer provider', error)
			return undefined
		}
	}

	private readonly setSignerProvider = (provider: WindowEthereum | undefined, request: EthereumRequest | undefined, fallbackRequest: EthereumRequest | undefined = undefined) => {
		if (this.signerWindowEthereumProvider !== provider) this.advanceSignerProviderGeneration()
		this.signerWindowEthereumProvider = provider
		this.signerWindowEthereumRequest = request
		this.fallbackSignerWindowEthereumRequest = fallbackRequest
	}

	private readonly advanceSignerProviderGeneration = () => {
		this.signerProviderGeneration++
		for (const waiter of this.signerProviderChangeWaiters) waiter.resolve(undefined)
		this.signerProviderChangeWaiters.clear()
		return this.signerProviderGeneration
	}

	private readonly requestAnnouncedProviders = () => {
		try {
			window.dispatchEvent(new Event('eip6963:requestProvider'))
		} catch (error: unknown) {
			this.reportSignerDiscoveryError('request EIP-6963 signer providers', error)
		}
	}

	private readonly stopSignerDiscoveryRetries = () => {
		if (this.signerDiscoveryRetryTimer === undefined) return
		clearTimeout(this.signerDiscoveryRetryTimer)
		this.signerDiscoveryRetryTimer = undefined
	}

	private readonly scheduleSignerDiscoveryRetry = () => {
		const waitingForAnySigner = this.signerAvailabilityWaiters.size > 0 && this.signerWindowEthereumRequest === undefined
		if (this.signerDiscoveryRetryTimer !== undefined || !waitingForAnySigner) return
		// A late wallet may start answering EIP-6963 requests without successfully replacing window.ethereum or dispatching ethereum#initialized.
		this.signerDiscoveryRetryTimer = setTimeout(() => {
			this.signerDiscoveryRetryTimer = undefined
			const stillWaitingForAnySigner = this.signerAvailabilityWaiters.size > 0 && this.signerWindowEthereumRequest === undefined
			if (!stillWaitingForAnySigner) return
			this.requestAnnouncedProviders()
			this.scheduleSignerDiscoveryRetry()
		}, SIGNER_DISCOVERY_RETRY_INTERVAL_MS)
	}

	private readonly waitForSignerAvailability = async () => {
		if (this.signerName === 'NoSigner') this.requestAnnouncedProviders()
		if (this.signerWindowEthereumRequest !== undefined) return true

		const signerAvailability = new InterceptorFuture<void>()
		this.signerAvailabilityWaiters.add(signerAvailability)
		this.scheduleSignerDiscoveryRetry()
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				Promise.resolve(signerAvailability),
				new Promise<void>((resolve) => { timeout = setTimeout(resolve, SIGNER_DISCOVERY_TIMEOUT_MS) }),
			])
		} finally {
			this.signerAvailabilityWaiters.delete(signerAvailability)
			if (this.signerAvailabilityWaiters.size === 0) this.stopSignerDiscoveryRetries()
			if (timeout !== undefined) clearTimeout(timeout)
		}
		return this.signerWindowEthereumRequest !== undefined
	}

	private readonly findPreparedLegacyMetaMaskProvider = (injectedWindowEthereum: WindowEthereum) => {
		let providers: readonly unknown[] | undefined
		try {
			const possibleProviders = injectedWindowEthereum.providers
			if (Array.isArray(possibleProviders)) providers = possibleProviders
		} catch (error: unknown) {
			this.reportSignerDiscoveryError('read legacy signer providers', error)
			return undefined
		}
		if (providers === undefined) return undefined
		let providerCount = 0
		try {
			providerCount = providers.length
		} catch (error: unknown) {
			this.reportSignerDiscoveryError('read legacy signer provider count', error)
			return undefined
		}
		for (let providerIndex = 0; providerIndex < providerCount; providerIndex++) {
			let provider: unknown
			try {
				provider = providers[providerIndex]
			} catch (error: unknown) {
				this.reportSignerDiscoveryError('read legacy signer provider', error)
				continue
			}
			if (provider === injectedWindowEthereum) continue
			const preparedSigner = this.prepareSignerProvider(provider, 'MetaMask', true)
			if (preparedSigner !== undefined) return preparedSigner
		}
		return undefined
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
			throw error
		}
	}

	private readonly WindowEthereumSendAsync = async (payload: SingleSendAsyncParam | SingleSendAsyncParam[], callback: LegacyJsonRpcCallback) => {
		let response: JsonRpcResponse | JsonRpcResponse[]
		try {
			response = Array.isArray(payload)
				? await Promise.all(payload.map((param) => this.getWindowEthereumSendAsyncResponse(param)))
				: await this.getWindowEthereumSendAsyncResponse(payload)
		} catch (error: unknown) {
			callback(error instanceof Error ? error : new Error(`Unexpected sendAsync failure: ${ String(error) }`), null)
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

	private static isStringArray(arr: unknown[]): arr is string[] {
		return arr.every(item => typeof item === 'string');
	}

	private readonly getSignerAccountsErrorReply = (error: unknown, requestAccounts: boolean): SignerAccountsReply => {
		if (InterceptorMessageListener.getErrorCodeAndMessage(error)) return { type: 'error', requestAccounts, error }
		const errorCode = InterceptorMessageListener.getErrorCode(error)
		if (errorCode !== undefined) return { type: 'error', requestAccounts, error: { message: InterceptorMessageListener.getFallbackErrorMessage(errorCode), code: errorCode } }
		if (error instanceof Error) return { type: 'error', requestAccounts, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }
		return { type: 'error', requestAccounts, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }
	}

	private readonly requestFromCurrentSigner = async (methodAndParams: { readonly method: string, readonly params?: EthereumRequestParameters }, allowRequestAccountsFallbackToRoot = false): Promise<SignerProviderRequestOutcome> => {
		const signerProviderGeneration = this.signerProviderGeneration
		const providerChange = new InterceptorFuture<void>()
		this.signerProviderChangeWaiters.add(providerChange)
		const signerRequest: Promise<SignerProviderRequestOutcome> = this.requestFromSigner(methodAndParams, allowRequestAccountsFallbackToRoot).then(
			(reply): SignerProviderRequestOutcome => ({ type: 'success', reply, signerProviderGeneration }),
			(error: unknown): SignerProviderRequestOutcome => ({ type: 'error', error, signerProviderGeneration }),
		)
		const providerChanged = Promise.resolve(providerChange).then((): SignerProviderRequestOutcome => ({ type: 'providerChanged', signerProviderGeneration }))
		try {
			const outcome = await Promise.race([signerRequest, providerChanged])
			if (signerProviderGeneration !== this.signerProviderGeneration) return { type: 'providerChanged', signerProviderGeneration }
			return outcome
		} finally {
			this.signerProviderChangeWaiters.delete(providerChange)
		}
	}

	private readonly resolveSignerAccountsFromCurrentProvider = async (requestAccounts: boolean): Promise<SignerAccountsResolution> => {
		for (;;) {
			const signerAvailable = await this.waitForSignerAvailability()
			const signerProviderGeneration = this.signerProviderGeneration
			if (!signerAvailable) {
				return {
					signerProviderGeneration,
					reply: {
						type: 'error',
						requestAccounts,
						signerUnavailable: true,
						error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
					},
				}
			}
			const method = requestAccounts ? 'eth_requestAccounts' : 'eth_accounts'
			const outcome = await this.requestFromCurrentSigner({ method, params: [] }, requestAccounts)
			if (outcome.type === 'providerChanged') continue
			if (outcome.type === 'error') return { signerProviderGeneration: outcome.signerProviderGeneration, reply: this.getSignerAccountsErrorReply(outcome.error, requestAccounts) }
			const reply = outcome.reply
			if (!Array.isArray(reply)) return { signerProviderGeneration, reply: this.getSignerAccountsErrorReply(new Error('Signer returned something else than an array'), requestAccounts) }
			if (!InterceptorMessageListener.isStringArray(reply)) return { signerProviderGeneration, reply: this.getSignerAccountsErrorReply(new Error('Signer did not return a string array'), requestAccounts) }
			this.signerAccounts = reply
			return { signerProviderGeneration, reply: { type: 'success', accounts: this.signerAccounts, requestAccounts } }
		}
	}

	private readonly sendSignerAccountsResolution = async (resolution: SignerAccountsResolution) => {
		await this.waitForLatestSignerConnectionTransition()
		if (resolution.signerProviderGeneration !== this.signerProviderGeneration) return false
		await this.sendInternalMessageToBackgroundPage({ method: 'eth_accounts_reply', params: [{ ...resolution.reply, signerProviderGeneration: resolution.signerProviderGeneration }] })
		return true
	}

	// attempts to call signer for eth_accounts
	private readonly getAccountsFromSigner = async () => {
		for (;;) {
			const resolution = await this.resolveSignerAccountsFromCurrentProvider(false)
			if (await this.sendSignerAccountsResolution(resolution)) return
		}
	}

	private readonly getSharedSignerAccountsResolution = async () => {
		const existingRequest = this.pendingSignerAddressRequest
		if (existingRequest !== undefined) return await existingRequest
		const pendingRequest = this.resolveSignerAccountsFromCurrentProvider(true)
		this.pendingSignerAddressRequest = pendingRequest
		try {
			return await pendingRequest
		} finally {
			if (this.pendingSignerAddressRequest === pendingRequest) this.pendingSignerAddressRequest = undefined
		}
	}

	// attempts to call signer for eth_requestAccounts
	private readonly requestAccountsFromSigner = async () => {
		for (;;) {
			const resolution = await this.getSharedSignerAccountsResolution()
			if (await this.sendSignerAccountsResolution(resolution)) return
		}
	}

	private readonly requestChainIdFromSigner = async () => {
		if (this.signerWindowEthereumRequest === undefined) return
		const outcome = await this.requestFromCurrentSigner({ method: 'eth_chainId', params: [] })
		if (outcome.type === 'providerChanged') return
		if (outcome.type === 'success') {
			const reply = outcome.reply
			if (typeof reply !== 'string') {
				this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', new Error('Signer eth_chainId returned a non-string reply.'), { requestMethod: 'eth_chainId' }))
				return
			}
			return await this.sendInternalMessageToBackgroundPage({ method: 'signer_chainChanged', params: [reply, outcome.signerProviderGeneration] })
		}
		console.error('failed to get chain Id from signer')
		console.error(outcome.error)
		this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', outcome.error, { requestMethod: 'eth_chainId' }))
		return undefined
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

	private readonly requestChangeChainFromSigner = async (chainId: string, walletSwitchRequestId: string) => {
		if (this.signerWindowEthereumRequest === undefined) {
			await this.sendInternalMessageToBackgroundPage({
				method: 'wallet_switchEthereumChain_reply',
				params: [{
					accept: false,
					chainId, walletSwitchRequestId,
					signerProviderGeneration: this.signerProviderGeneration,
					error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
				}],
			})
			return
		}

		const outcome = await this.requestFromCurrentSigner({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
		if (outcome.type === 'success') {
			const params = outcome.reply === null
				? { accept: true as const, chainId, walletSwitchRequestId, signerProviderGeneration: outcome.signerProviderGeneration }
				: {
					accept: false as const,
					chainId, walletSwitchRequestId,
					signerProviderGeneration: outcome.signerProviderGeneration,
					error: { code: METAMASK_ERROR_BLANKET_ERROR, message: 'Signer returned an invalid wallet_switchEthereumChain reply.' },
				}
			await this.sendInternalMessageToBackgroundPage({ method: 'wallet_switchEthereumChain_reply', params: [params] })
			return
		}
		const error = outcome.type === 'providerChanged'
			? { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' }
			: this.normalizeSignerErrorForBackground(outcome.error)
		await this.sendInternalMessageToBackgroundPage({
			method: 'wallet_switchEthereumChain_reply',
			params: [{ accept: false, chainId, walletSwitchRequestId, error, signerProviderGeneration: outcome.signerProviderGeneration }],
		})
	}

	private readonly requestWatchAssetFromSigner = async (parameters: unknown) => {
		if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)
			|| !('parameters' in parameters)
			|| typeof parameters.parameters !== 'object'
			|| parameters.parameters === null
			|| Array.isArray(parameters.parameters)
			|| !('uniqueRequestIdentifier' in parameters)
			|| typeof parameters.uniqueRequestIdentifier !== 'object'
			|| parameters.uniqueRequestIdentifier === null
			|| !('requestId' in parameters.uniqueRequestIdentifier)
			|| typeof parameters.uniqueRequestIdentifier.requestId !== 'number'
			|| !('signerIdentity' in parameters)
			|| typeof parameters.signerIdentity !== 'object'
			|| parameters.signerIdentity === null
			|| !('tabId' in parameters.signerIdentity)
			|| typeof parameters.signerIdentity.tabId !== 'number'
			|| !('connectionName' in parameters.signerIdentity)
			|| typeof parameters.signerIdentity.connectionName !== 'string'
			|| !('ownerGeneration' in parameters.signerIdentity)
			|| typeof parameters.signerIdentity.ownerGeneration !== 'number'
			|| !('signerProviderGeneration' in parameters.signerIdentity)
			|| typeof parameters.signerIdentity.signerProviderGeneration !== 'number'
		) throw new Error('Malformed wallet_watchAsset signer request.')
		const walletParameters = Object.fromEntries(Object.entries(parameters.parameters))
		const forwardRequest: {
			type: 'forwardToSigner'
			replyWithSignersReply: true
			method: string
			requestId: number
			params: unknown
		} = {
			type: 'forwardToSigner',
			replyWithSignersReply: true,
			method: 'wallet_watchAsset',
			requestId: parameters.uniqueRequestIdentifier.requestId,
			params: parameters,
		}
		if (this.signerWindowEthereumRequest === undefined || this.signerProviderGeneration !== parameters.signerIdentity.signerProviderGeneration) {
			await this.sendSignerReplyToBackgroundPage({
				success: false,
				forwardRequest,
				error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the watch-asset request reached the wallet.' },
				signerProviderGeneration: parameters.signerIdentity.signerProviderGeneration,
			})
			return
		}
		const outcome = await this.requestFromCurrentSigner({ method: 'wallet_watchAsset', params: walletParameters })
		const signerReply: {
			success: true
			forwardRequest: typeof forwardRequest
			reply: unknown
			signerProviderGeneration: number
		} | {
			success: false
			forwardRequest: typeof forwardRequest
			error: { code: number, message: string, data?: unknown }
			signerProviderGeneration: number
		} = outcome.type === 'success'
			? { success: true, forwardRequest, reply: outcome.reply, signerProviderGeneration: outcome.signerProviderGeneration }
			: {
				success: false,
				forwardRequest,
				error: outcome.type === 'error'
					? this.normalizeSignerErrorForBackground(outcome.error)
					: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' },
				signerProviderGeneration: outcome.signerProviderGeneration,
			}
		await this.sendSignerReplyToBackgroundPage(signerReply)
	}

	private readonly handleReplyRequest = async(replyRequest: InterceptedRequestForwardWithResult): Promise<void> => {
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
						callback({ name: 'disconnect', code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Provider disconnected from all chains.' })
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
						setCompatibilityProperty(inpageWindow.ethereum, 'networkVersion', chainIdToNetworkVersion(reply), 'window.ethereum.networkVersion')
					}
					for (const callback of this.onChainChangedCallBacks) {
						callback(reply)
					}
					return
				}
				case 'safe_apps_compatibility': {
					const safeAppsCompatibility = parseSafeAppsCompatibility(replyRequest.result)
					if (safeAppsCompatibility !== undefined) this.safeAppsBridge.setEnabled(safeAppsCompatibility.enabled, safeAppsCompatibility.canRequestAccess)
					return
				}
				case 'request_signer_to_eth_requestAccounts': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.requestAccountsFromSigner())
					return
				}
				case 'request_signer_to_eth_accounts': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.getAccountsFromSigner())
					return
				}
				case 'request_signer_to_wallet_switchEthereumChain': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					if (typeof replyRequest.result !== 'string' || typeof replyRequest.walletSwitchRequestId !== 'string') throw new Error('Invalid wallet switch command')
					const chainId = replyRequest.result
					const walletSwitchRequestId = replyRequest.walletSwitchRequestId
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.requestChangeChainFromSigner(chainId, walletSwitchRequestId))
					return
				}
				case 'request_signer_to_wallet_watchAsset': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.requestWatchAssetFromSigner(replyRequest.result))
					return
				}
				case 'request_signer_connection_status': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					if (this.signerProviders.isRecoveringSignerConnection()) {
						this.signerProviders.enqueueProviderCatalogSynchronization()
						return
					}
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.connectToSigner(this.signerName))
					return
				}
				case 'request_signer_chainId': {
					if (!this.initialSignerProviderCatalogReconciled) await this.initialSignerProviderCatalogReconciliation
					await this.signerProviders.runWithSignerSelectionBlocked(async () => await this.requestChainIdFromSigner())
					return
				}
				case 'select_signer_provider': {
					if (typeof replyRequest.result !== 'string') throw new Error('Invalid EIP-6963 signer selection')
					await this.signerProviders.selectAnnouncedProvider(replyRequest.result, 'explicit')
					return
				}
				case 'request_signer_provider_catalog': {
					this.signerProviders.enqueueProviderCatalogSynchronization()
					return
				}
				default: break
			}
		} finally {
			if (replyRequest.requestId !== undefined && !isRequestScopedProviderEventMethod(replyRequest.method)) {
				const pending = this.outstandingRequests.get(replyRequest.requestId)
				if (pending !== undefined) {
					const originalRequestMethod = pending.method
					if (shouldResolveAfterRequestScopedProviderEvents(originalRequestMethod, replyRequest.method)) {
						this.resolveWithRequestScopedProviderEvents(replyRequest.requestId, replyRequest.result)
					} else {
						pending.future.resolve(replyRequest.result)
					}
				}
			}
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

	private normalizeSignerErrorForBackground = (error: unknown) => {
		const parsedError = this.parseRpcError(error)
		return {
			code: parsedError.code,
			message: parsedError.message,
			...(typeof parsedError.data === 'string' ? { data: parsedError.data } : {}),
		}
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
		const messageData = messageEvent.data
		if ('type' in messageData
			&& messageData.type === INTERCEPTOR_BRIDGE_INITIALIZED_MESSAGE
			&& 'bridgeCapability' in messageData
			&& messageData.bridgeCapability === this.bridgeCapability
			&& 'contentScriptCapability' in messageData
			&& isUuid(messageData.contentScriptCapability)) {
			if (this.contentScriptCapability !== undefined && this.contentScriptCapability !== messageData.contentScriptCapability) return
			this.contentScriptCapability = messageData.contentScriptCapability
			this.contentScriptBridgeInitialized.resolve(undefined)
			for (const diagnostics of this.pendingBridgeDiagnostics.splice(0)) this.reportInterceptorError(diagnostics)
			return
		}
		if (this.contentScriptCapability === undefined
			|| !('contentScriptCapability' in messageData)
			|| messageData.contentScriptCapability !== this.contentScriptCapability) return
		const { contentScriptCapability: _contentScriptCapability, ...authenticatedMessageData } = messageData
		if ('type' in authenticatedMessageData
			&& authenticatedMessageData.type === INTERCEPTOR_BRIDGE_RECONNECTED_MESSAGE
			&& 'bridgeCapability' in authenticatedMessageData
			&& authenticatedMessageData.bridgeCapability === this.bridgeCapability) {
			this.signerProviders.handleBridgeReconnect()
			for (const outstandingRequest of this.outstandingRequests.values()) {
				if (isInternalBackgroundMethod(outstandingRequest.method)) {
					outstandingRequest.future.reject(new SignerSynchronizationBridgeReconnectedError('The background bridge reconnected before signer synchronization completed'))
				} else if (PUBLIC_QUERIES_INTERRUPTED_BY_RECONNECT.has(outstandingRequest.method)) {
					outstandingRequest.future.reject(new EthereumJsonRpcError(METAMASK_ERROR_PROVIDER_DISCONNECTED, 'The background bridge reconnected before the query completed. Retry the request.'))
				}
			}
			this.signerProviders.enqueueProviderCatalogSynchronization()
			return
		}
		try {
			if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) throw new Error('window.ethereum missing')
			const forwardRequest = parseInterceptorApprovedMessage(authenticatedMessageData)
			if (forwardRequest === undefined) throw new Error('Malformed message from content script')
			if (forwardRequest.type === 'result' && forwardRequest.requestId !== undefined && !this.outstandingRequests.has(forwardRequest.requestId)) return
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
							const chainId = forwardRequest.result
							setCompatibilityProperty(inpageWindow.ethereum, 'chainId', chainId, 'window.ethereum.chainId')
							setCompatibilityProperty(inpageWindow.ethereum, 'networkVersion', chainIdToNetworkVersion(chainId), 'window.ethereum.networkVersion')
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
				const outcome = await this.requestFromCurrentSigner({ method: forwardRequest.method, params: 'params' in forwardRequest ? forwardRequest.params : [] })
				if (outcome.type === 'success') return { success: true as const, forwardRequest, reply: outcome.reply, signerProviderGeneration: outcome.signerProviderGeneration }
				if (outcome.type === 'error') return { success: false as const, forwardRequest, error: this.normalizeSignerErrorForBackground(outcome.error), signerProviderGeneration: outcome.signerProviderGeneration }
				return {
					success: false as const,
					forwardRequest,
					error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' },
					signerProviderGeneration: outcome.signerProviderGeneration,
				}
			}
			const completedSignerReply = await sendToSignerWithCatchError()
			try {
				if ('replyWithSignersReply' in forwardRequest) {
					while (this.signerProviders.isRecoveringSignerConnection()) await this.signerProviders.waitForSignerConnectionRecovery()
					const signerReply = this.checkSignerReplyGeneration(completedSignerReply)
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
				await this.sendSignerReplyToBackgroundPage(completedSignerReply)
			} catch(error: unknown) {
				// Delivery belongs to the original dapp request: even a reconnect must reject it, rather than enter the control-plane retry path below.
				if (error instanceof Error) return pendingRequest.future.reject(error)
				return pendingRequest.future.reject(this.parseRpcError(error))
			}
		} catch(error: unknown) {
			if (error instanceof SignerSynchronizationBridgeReconnectedError) return
			console.error(error)
			this.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'handle background reply', error, getForwardedDiagnosticsRequestContext(authenticatedMessageData)))
			const requestId = 'requestId' in authenticatedMessageData && typeof authenticatedMessageData.requestId === 'number' ? authenticatedMessageData.requestId : undefined
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
			const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (legacyWeb3 !== undefined) {
				setCompatibilityProperty(legacyWeb3, 'currentProvider', inpageWindow.ethereum, 'window.web3.currentProvider')
			} else {
				setCompatibilityProperty(inpageWindow, 'web3', { accounts: [], currentProvider: inpageWindow.ethereum }, 'window.web3')
			}
			this.installControlledAccountCompatibilityProperties()
		}
	}

	private readonly connectToSigner = (signerName: Signer, preserveProviderGeneration = false) => {
		this.signerName = signerName
		const signerProviderGeneration = preserveProviderGeneration ? this.signerProviderGeneration : this.advanceSignerProviderGeneration()
		if (this.signerWindowEthereumRequest !== undefined) {
			for (const waiter of this.signerAvailabilityWaiters) waiter.resolve(undefined)
			this.signerAvailabilityWaiters.clear()
			this.stopSignerDiscoveryRetries()
		}
		const selectionGeneration = ++this.signerSelectionGeneration
		const connectToSigner = async (): Promise<{ metamaskCompatibilityMode: boolean }> => {
			const connectSignerReply = await this.sendInternalMessageToBackgroundPage({ method: 'connected_to_signer', params: [signerName !== 'NoSigner', signerName, signerProviderGeneration] })
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
			// Account replies only require confirmed provider identity; chain initialization must not hold them back.
			if (signerName !== 'NoSigner') void this.requestChainIdFromSigner().catch((error: unknown) => {
				// Use the same discovery diagnostic helper as provider selection and account initialization.
				this.reportSignerDiscoveryError('initialize signer chain', error)
			})
		}
		// A fresh status report must not wait behind an older bridge request whose reply may have been lost during a background-worker or content-port replacement. The generation checks on both sides make late replies from superseded reports harmless.
		const transition = completeTransition().catch((error: unknown) => {
			if (preserveProviderGeneration) throw error
			this.reportSignerDiscoveryError('report signer connection status', error)
		})
		// Public callers wait for completion and the recovery barrier; the coordinator receives the rejecting transition so it can retry. A failed control-plane report must never become a cached dapp error.
		this.latestSignerConnectionTransition = transition.catch((error: unknown) => this.reportSignerDiscoveryError('report signer recovery status', error))
		for (const waiter of this.signerConnectionTransitionChangeWaiters) waiter.resolve(undefined)
		this.signerConnectionTransitionChangeWaiters.clear()
		return transition
	}

	private readonly waitForLatestSignerConnectionTransition = async () => {
		for (;;) {
			const transition = this.latestSignerConnectionTransition
			const transitionChanged = new InterceptorFuture<void>()
			this.signerConnectionTransitionChangeWaiters.add(transitionChanged)
			try {
				await Promise.race([transition, Promise.resolve(transitionChanged)])
			} finally {
				this.signerConnectionTransitionChangeWaiters.delete(transitionChanged)
			}
			if (transition !== this.latestSignerConnectionTransition) continue
			await transition
			return
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
		const interceptorProviderUuid = generateUuidV4()
		window.addEventListener('eip6963:announceProvider', this.signerProviders.collectAnnouncedProvider)
		// Other extensions also inject at document_start, so the first request can run before their EIP-6963 listeners exist. Refresh at bounded page lifecycle milestones even when a usable legacy window.ethereum signer was found.
		window.addEventListener('DOMContentLoaded', this.requestAnnouncedProviders, { once: true })
		window.addEventListener('load', this.requestAnnouncedProviders, { once: true })
		function announceProvider() {
			const info: EIP6963ProviderInfo = {
				uuid: interceptorProviderUuid,
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
		// The empty catalog is meaningful: it lets the background resolve a remembered site preference as unavailable instead of falling through to a legacy signer.
		this.signerProviders.enqueueProviderCatalogSynchronization()
	}

	public readonly handleEthereumInitialized = () => {
		this.requestAnnouncedProviders()
		this.injectEthereumIntoWindow()
	}

	public readonly injectEthereumIntoWindow = () => {
		if (!this.signerProviders.canActivateLegacySigner()) {
			let rootIsInterceptor = false
			try { rootIsInterceptor = inpageWindow.ethereum?.isInterceptor === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Interceptor marker', error) }
			if (!rootIsInterceptor) {
				// A late legacy wallet may replace window.ethereum after selection. Restore our facade without changing the coordinator's active provider or its generation.
				inpageWindow.ethereum = this.createInterceptorProvider(this.signerWindowEthereumProvider)
				this.installControlledAccountCompatibilityProperties()
			}
			return
		}
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
			this.signerProviders.scheduleInitialSignerConnection('NoSigner')
			return
		}
		const injectedWindowEthereum = inpageWindow.ethereum
		const useNoSigner = () => {
			inpageWindow.ethereum = this.createInterceptorProvider(undefined)
			this.connected = true
			this.setSignerProvider(undefined, undefined)
			this.signerProviders.scheduleInitialSignerConnection('NoSigner')
		}
		let rootIsInterceptor = false
		try { rootIsInterceptor = injectedWindowEthereum.isInterceptor === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Interceptor marker', error) }
		if (rootIsInterceptor) return
		const preparedMetaMaskProvider = this.findPreparedLegacyMetaMaskProvider(injectedWindowEthereum)

		let rootIsAmbire = false
		let rootIsBraveWallet = false
		let rootIsCoinbaseWallet = false
		let rootIsMetaMask = false
		let rootIsRabby = false
		let rootProviderMap: Map<string, WindowEthereum> | undefined
		try { rootIsAmbire = injectedWindowEthereum.isAmbire === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Ambire marker', error) }
		try { rootIsBraveWallet = injectedWindowEthereum.isBraveWallet === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Brave marker', error) }
		try { rootIsCoinbaseWallet = injectedWindowEthereum.isCoinbaseWallet === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Coinbase marker', error) }
		try { rootIsMetaMask = injectedWindowEthereum.isMetaMask === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root MetaMask marker', error) }
		try { rootIsRabby = injectedWindowEthereum.isRabby === true } catch (error: unknown) { this.reportSignerDiscoveryError('read root Rabby marker', error) }
		try { rootProviderMap = injectedWindowEthereum.providerMap } catch (error: unknown) { this.reportSignerDiscoveryError('read root provider map', error) }
		const rootSignerName = getSignerNameFromWalletMarkers({
			isAmbire: rootIsAmbire,
			isBrave: rootIsBraveWallet,
			isCoinbase: rootIsCoinbaseWallet,
			isMetaMask: rootIsMetaMask,
			isRabby: rootIsRabby,
		})

		if (preparedMetaMaskProvider === undefined && (rootIsBraveWallet || rootProviderMap !== undefined || rootIsCoinbaseWallet)) {
			let mapSignerWindowEthereum: WindowEthereum | undefined
			try { mapSignerWindowEthereum = rootProviderMap?.get('CoinbaseWallet') } catch (error: unknown) { this.reportSignerDiscoveryError('read mapped Coinbase signer', error) }
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
				try { fallbackRequest = injectedWindowEthereum.request.bind(injectedWindowEthereum) } catch (error: unknown) { this.reportSignerDiscoveryError('bind root fallback signer request', error) }
			}
			this.connected = preparedSigner.connected
			this.setSignerProvider(preparedSigner.provider, preparedSigner.request, fallbackRequest)
			inpageWindow.ethereum = this.createInterceptorProvider(preparedSigner.provider)
			this.installControlledAccountCompatibilityProperties()
			this.signerProviders.scheduleInitialSignerConnection(signerName)
			return
		}
		const preparedRootSigner = preparedMetaMaskProvider ?? this.prepareSignerProvider(injectedWindowEthereum, rootSignerName, false, false)
		if (preparedRootSigner === undefined) {
			useNoSigner()
			return
		}
		const fallbackSignerWindowEthereum = preparedRootSigner.provider
		const fallbackSignerName = preparedMetaMaskProvider === undefined ? rootSignerName : 'MetaMask'
		this.setSignerProvider(fallbackSignerWindowEthereum, preparedRootSigner.request)
		this.connected = preparedRootSigner.connected
		// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
		if (fallbackSignerWindowEthereum !== injectedWindowEthereum || this.hasNonConfigurableAccountCompatibilityProperty()) {
			this.installControlledAccountCompatibilityProperties()
			inpageWindow.ethereum = this.createInterceptorProvider(fallbackSignerWindowEthereum)
		} else {
			Object.assign(fallbackSignerWindowEthereum, this.createInterceptorProvider(fallbackSignerWindowEthereum))
		}
		this.installControlledAccountCompatibilityProperties()
		this.signerProviders.scheduleInitialSignerConnection(fallbackSignerName)
	}
}

function injectInterceptor() {
	const interceptorMessageListener = new InterceptorMessageListener()
	window.addEventListener('message', interceptorMessageListener.onWindowMessage)

	// keep listening for other wallets that announce themselves and reinject without patching dispatchEvent
	window.addEventListener('ethereum#initialized', interceptorMessageListener.handleEthereumInitialized)
	window.dispatchEvent(new Event('ethereum#initialized'))
	return interceptorMessageListener
}

// Install the public provider at document_start; the privileged bootstrap only enables its private bridge.
const interceptorMessageListener = injectInterceptor()

// Chrome invokes this fixed entry point with an isolated-script nonce. The endpoint never leaves its closed shadow root.
installInpageBridgeInitializer(window, interceptorMessageListener.initializeBridge)
const documentStartBridgeSecret = '[[interceptor-bootstrap-secret]]'
if (!documentStartBridgeSecret.startsWith('[[')) {
	// Firefox's isolated document_start script installs the private-root listener after inline injection returns.
	queueMicrotask(() => interceptorMessageListener.initializeBridge(documentStartBridgeSecret))
}
