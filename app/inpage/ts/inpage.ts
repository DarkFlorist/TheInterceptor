// inpage.js runs as a classic script in the page's MAIN world (an MV3 content script, or inline via document_start.js in MV2), so all of it lives in this function scope to keep top-level bindings from becoming page globals that collide with dapp declarations.
(() => {
	// Only the first run in a page installs the provider. A second run would start a second provider next to the first: another bridge to the content script and another set of page listeners and EIP-6963 announcements. MV2 can run this script again in a page that outlived an extension reload or update, because document_start.js records its injection only in the content-script world of the extension instance that injected it, and any frame navigation in the page makes the new instance inject into the top frame. Before this file was wrapped in a function, the second run stopped at its first top-level const redeclaration; this marker keeps that guarantee explicit. It is a non-enumerable Symbol.for key, so the only string-named page globals stay window.ethereum and window.web3. It stays configurable, like the content-script marker in listenContentScript.ts, because the guard only checks that it exists and some browsers refuse non-configurable properties on window.
	const INPAGE_SCRIPT_RAN_MARKER = Symbol.for('TheInterceptor.inpageScriptRan')
	if (Object.getOwnPropertyDescriptor(window, INPAGE_SCRIPT_RAN_MARKER) !== undefined) return
	Object.defineProperty(window, INPAGE_SCRIPT_RAN_MARKER, { value: true, enumerable: false, writable: false, configurable: true })

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

	type Deferred<T> = {
		readonly promise: Promise<T>
		readonly resolve: (value: T | PromiseLike<T>) => void
		readonly reject: (reason: Error) => void
	}

	function createDeferred<T>(): Deferred<T> {
		let resolve: Deferred<T>['resolve'] = () => undefined
		let reject: Deferred<T>['reject'] = () => undefined
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise
			reject = rejectPromise
		})
		// The Promise executor runs synchronously, so both settlers belong to this promise by the time the deferred is returned.
		return { promise, resolve, reject }
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
		'safe_apps_request',
		'signer_chainChanged',
		'signer_reply',
		'wallet_switchEthereumChain_reply',
	] as const

	const isInternalBackgroundMethod = (method: string) => INTERNAL_BACKGROUND_METHODS.some((internalMethod) => internalMethod === method)

	// Internal requests whose background reply carries data the inpage reads. signer_reply is not listed because only the bridge's sendSignerReply sends it.
	type InternalBackgroundRequestMethod = 'connected_to_signer' | 'safe_apps_request'
	// Internal notifications: the background answers them with doNotReply or with a placeholder result that the inpage never reads. signer_reply is not listed because only the bridge's sendSignerReply sends it.
	type InternalBackgroundNotificationMethod = 'eth_accounts_reply' | 'signer_chainChanged' | 'wallet_switchEthereumChain_reply'

	// The background's signerReply handler settles these forwarded requests itself (confirmation flow or watch-asset queue) and returns doNotReply. For every other forwarded method it answers the signer_reply request, with the signer's reply or error, or with an error when the reply arrives over a replaced connection. The bridge's sendSignerReply uses this list to send signer_reply as a notification or as a request. This classic script cannot import background modules, so this mirrors FORWARDED_METHODS_SETTLED_BY_BACKGROUND in app/ts/background/forwardedRequestSettlement.ts, and test/tests/forwardedMethodsSettledByBackground.test.ts keeps the two lists equal.
	const FORWARDED_METHODS_SETTLED_BY_BACKGROUND: ReadonlySet<string> = new Set([
		'personal_sign',
		'eth_signTypedData',
		'eth_signTypedData_v1',
		'eth_signTypedData_v2',
		'eth_signTypedData_v3',
		'eth_signTypedData_v4',
		'eth_sendRawTransaction',
		'eth_sendTransaction',
		'wallet_watchAsset',
	])

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

	const INTERCEPTOR_BRIDGE_PORT_MESSAGE = 'interceptor_bridge_port'
	const INTERCEPTOR_BRIDGE_REQUEST_MESSAGE = 'interceptor_bridge_request'
	const REQUEST_SCOPED_PROVIDER_EVENT_METHODS = new Set(['accountsChanged', 'connect', 'disconnect', 'chainChanged'])

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
		readonly method: string
		readonly params?: readonly unknown[]
		readonly usingInterceptorWithoutSigner: boolean
		readonly requestId: number
		readonly internal?: true
		readonly replayOnDisconnect?: true
	}

	const isMessageCandidate = (value: unknown): value is InterceptorApprovedMessageCandidate => typeof value === 'object' && value !== null
	const isErrorCandidate = (value: unknown): value is InterceptorErrorCandidate => typeof value === 'object' && value !== null
	const isEip6963AnnouncementDetail = (value: unknown): value is { provider: unknown, info: unknown } => typeof value === 'object' && value !== null && 'provider' in value && 'info' in value
	const isValidImageDataUri = (value: string) => {
		const match = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]+)*(;base64)?,(.+)$/is.exec(value)
		if (match === null) return false
		const payload = match[2]
		if (payload === undefined) return false
		if (match[1] === ';base64') return /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=|[a-z0-9+/]{2}|[a-z0-9+/]{3})?$/i.test(payload)
		try {
			return decodeURIComponent(payload).length > 0
		} catch (error: unknown) {
			if (error instanceof URIError) return false
			throw error
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

	type WindowEthereum = InjectFunctions & {
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

	interface EIP6963ProviderInfo {
		uuid: string
		name: string
		icon: string
		rdns: string
	}

	type SingleSendAsyncParam = { readonly id: string | number | null, readonly method: string, readonly params: InterceptorEthereumRequestParameters }
	type ForwardedDiagnosticsRequestContext = {
		readonly requestId?: number
		readonly requestMethod?: string
	}

	type OutstandingRequest = {
		readonly reply: Deferred<unknown>
		readonly method: string
		requestScopedProviderEventCallbacks?: (() => void)[]
	}

	type OnMessage = 'accountsChanged' | 'message' | 'connect' | 'close' | 'disconnect' | 'chainChanged'
	type Signer = 'NoSigner' | 'NotRecognizedSigner' | 'MetaMask' | 'Ambire' | 'Brave' | 'CoinbaseWallet' | 'Rabby'

	function getSignerNameFromWalletMarkers(markers: { readonly isAmbire: boolean, readonly isBrave: boolean, readonly isCoinbase: boolean, readonly isMetaMask: boolean, readonly isRabby: boolean }): Signer {
		if (markers.isCoinbase) return 'CoinbaseWallet'
		if (markers.isAmbire) return 'Ambire'
		if (markers.isBrave) return 'Brave'
		if (markers.isRabby) return 'Rabby'
		if (markers.isMetaMask) return 'MetaMask'
		return 'NotRecognizedSigner'
	}

	function canAnnouncedMetaMaskReplaceSigner(signerName: Signer): boolean {
		switch (signerName) {
			case 'NoSigner':
			case 'MetaMask':
			case 'Ambire':
			case 'Brave':
			case 'Rabby':
				return true
			case 'NotRecognizedSigner':
			case 'CoinbaseWallet':
				return false
		}
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

	// The provider is assembled from the factories below, composed by injectInterceptor at the end of this file. They live in this single classic script because MV3 registers inpage.js as a MAIN world content script and MV2 inlines it into document_start.js, so neither path can load modules.

	const INTERCEPTOR_PROVIDER_ICON ='data:image/svg+xml,%3Csvg%20width%3D%2232%22%20height%3D%2232%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M8%2021.32c.03%200%20.06%200%20.08-.01h.05c.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.06-.01.09-.01.02%200%20.03%200%20.05-.01.03%200%20.07-.01.1-.02.01%200%20.03%200%20.04-.01.04-.01.08-.01.12-.02h.02c.1-.02.19-.04.29-.07.01%200%20.02-.01.03-.01l.12-.03c.02%200%20.03-.01.05-.01l.1-.03c.01%200%20.01%200%20.02-.01%201.38-.44%203.08-1.52%205.14-3.68l2.07%201.52.79-5.87%203.29-2.67S8.43%205.37%206.76%205.07c-1.67-.29-4.29%201.5-5.37%202.67-.89.96.07%204.21.45%205.37.07.23.32.35.55.27l.04-.01c.17-.06.28-.22.29-.4.01-.24.1-.48.26-.68l.18-.23c.14-.17.32-.3.52-.37l2.79-.98c.36-.13.76-.07%201.07.16l4.49%203.29c.32.23.5.61.47%201l-.01.1c-.02.31-.16.6-.39.8l-.01.01-.28.25-.09.08-.2.17-.1.08c-.06.06-.13.11-.19.17l-.08.07c-.09.08-.18.15-.27.23l-.02.01c-.08.07-.16.14-.24.2l-.08.07-.18.15-.08.07c-.06.05-.12.1-.18.14l-.07.06c-.08.07-.16.13-.24.19l-.02.02c-.07.06-.14.11-.21.17l-.07.05c-.05.04-.11.08-.16.13l-.07.05c-.06.04-.11.08-.16.13l-.05.04c-.07.06-.14.11-.21.16l-.03.04H8.8c-.06.05-.12.09-.18.14l-.06.04c-.05.04-.1.07-.14.1l-.06.04c-.05.04-.1.07-.15.11l-.04.03c-.01.01-.02.01-.03.02l-.01-.01h.04l-1.21-1.3c-.87-1.53.65-3.52%201.55-4.5a.31.31%200%200%200-.04-.45l-1.5-1.1a.31.31%200%200%200-.28-.04l-2.56.89c-.05.02-.1.05-.14.1-.08.1-.09.23-.03.34l1.3%202.26c.05.09.05.19.01.29-.3.61-1.42%202.98-.8%203.64h-.02s.36.68%201.14%201.23c.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.02.02.04.02.01.01.03.02.04.02.01.01.02.01.04.02.01.01.03.02.04.02.01.01.03.01.04.02s.03.02.04.02c-.01.05.01.06.02.07.02.01.03.02.05.02.01.01.02.01.04.02s.03.02.05.02c.01.01.02.01.04.02.01.01.03.02.05.03.01%200%20.02.01.03.01.03.01.06.03.09.04.01%200%20.01%200%20.02.01.03.01.05.02.08.03.01%200%20.02.01.03.01.02.01.04.02.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02.01.04.01.06.02.01%200%20.03.01.04.01.02%200%20.04.01.07.01.01%200%20.03.01.04.01.02%200%20.05.01.07.01.01%200%20.03%200%20.04.01.03%200%20.05.01.08.01.01%200%20.02%200%20.03.01.03%200%20.06.01.09.01h.02c.08.01.16.01.24.02zm3.85-10.75c0-.57.46-1.03%201.03-1.03s1.03.46%201.03%201.03-.46%201.03-1.03%201.03-1.03-.46-1.03-1.03m3.44%2012.15c-2.88-.17-4.88-.79-5.41-.98l-.01.01-.33.11-.02.01c-.04.01-.08.02-.12.04h-.01l-.04.01c-.04.01-.09.02-.13.04h-.01l-.03.01c-.11.03-.23.06-.34.08h-.02l-.14.03-.04.01h-.01c-.04.01-.08.01-.12.02l-.04-.01h-.01c-.04%200-.07.01-.11.01h-.06c-.03%200-.07.01-.1.01h-.06c-.03%200-.07%200-.1.01h-.12l-.09%204.4h3.88l.3-2.38c.46.2.91.41%201.43.48v.88h-.01v1.45h3.88l.06-1.06c.04-.35.1-.76.15-1.19%201.11-.11%202.2-.36%203.26-.78.4.96.9%202.44.9%202.44h4.2l.13-5.44a24.1%2024.1%200%200%201-9.25%201.83c-.52%200-1.01-.02-1.46-.04%22%20fill%3D%22currentColor%22%2F%3E%3Cpath%20d%3D%22M30.76%2014.1c-.51-1.23-1.69-2.01-2.88-2.67.11-.24.18-.5.18-.78%200-1.04-.84-1.88-1.88-1.88s-1.88.84-1.88%201.88.84%201.88%201.88%201.88c.47%200%20.89-.19%201.22-.48%201.02%201.06%202.06%202.52-1.17%204l-.23-.63c-.5%200-1.51.5-1.51.5l.34-1c-.84-.5-2.01-.34-2.01-.34l.67-.84c-.7-.7-2.32-.58-2.85-.52.13-.06.33-.23.67-.65-.74-.3-1.32-.36-1.77-.3l-1.48%201.2-.75%205.55-.19%201.38-.03.2-2.71-1.99c-1.17%201.14-2.3%202.01-3.37%202.6%202.32.6%208.4%201.69%2015.01-1.19v-.01c2.66-1.14%205.9-3.12%204.74-5.91M19.3%2019.61c-.36-1.49-.09-3.36.67-4.69.36%201.49.1%203.35-.67%204.69m3.02%200c-.35-.96-.08-2.07.67-2.76.35.95.08%202.07-.67%202.76%22%20fill%3D%22currentColor%22%2F%3E%3C%2Fsvg%3E'

	const isProviderWithRequestAndOn = (provider: unknown): provider is WindowEthereum => {
		return typeof provider === 'object'
			&& provider !== null
			&& 'request' in provider
			&& typeof provider.request === 'function'
			&& 'on' in provider
			&& typeof provider.on === 'function'
	}

	const hasUsableSignerInterface = (provider: unknown): provider is WindowEthereum => {
		return isProviderWithRequestAndOn(provider)
			&& (provider.isConnected === undefined || typeof provider.isConnected === 'function')
	}

	const hasNoConflictingWalletMarkers = (provider: WindowEthereum) => {
		return (provider.isMetaMask === undefined || provider.isMetaMask === true)
			&& (provider.isAmbire === undefined || provider.isAmbire === false)
			&& (provider.isBraveWallet === undefined || provider.isBraveWallet === false)
			&& (provider.isCoinbaseWallet === undefined || provider.isCoinbaseWallet === false)
			&& (provider.isRabby === undefined || provider.isRabby === false)
			&& (provider.isInterceptor === undefined || provider.isInterceptor === false)
	}

	const isStringArray = (values: readonly unknown[]): values is string[] => values.every((value) => typeof value === 'string')

	const hasErrorCodeAndMessage = (error: unknown): error is { code: number, message: string } => {
		if (typeof error !== 'object' || error === null) return false
		if (!('code' in error) || !('message' in error)) return false
		return typeof error.code === 'number' && typeof error.message === 'string'
	}

	const getErrorCode = (error: unknown) => {
		if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
		return typeof error.code === 'number' ? error.code : undefined
	}

	const getFallbackErrorMessage = (errorCode: number) => errorCode === METAMASK_ERROR_USER_REJECTED_REQUEST ? 'User rejected the request.' : 'Signer request failed.'

	const isUserRejectedRequestError = (error: unknown) => getErrorCode(error) === METAMASK_ERROR_USER_REJECTED_REQUEST

	const getProviderConnectInfo = (result: unknown): ProviderConnectInfo => {
		if (typeof result === 'string') return { chainId: result }
		if (Array.isArray(result) && typeof result[0] === 'string') return { chainId: result[0] }
		throw new Error('wrong type')
	}

	const exhaustivenessCheck = (_thing: never) => undefined

	function parseRpcError(maybeErrorObject: unknown) {
		if (typeof maybeErrorObject !== 'object' || maybeErrorObject === null) return new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { rawError: maybeErrorObject })
		if (hasErrorCodeAndMessage(maybeErrorObject)) return new EthereumJsonRpcError(maybeErrorObject.code, maybeErrorObject.message, 'data' in maybeErrorObject && maybeErrorObject.data !== undefined ? maybeErrorObject.data : undefined)
		const errorCode = getErrorCode(maybeErrorObject)
		if (errorCode !== undefined) return new EthereumJsonRpcError(errorCode, getFallbackErrorMessage(errorCode), 'data' in maybeErrorObject && maybeErrorObject.data !== undefined ? maybeErrorObject.data : undefined)
		return new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', maybeErrorObject)
	}

	function normalizeSignerErrorForBackground(error: unknown) {
		const parsedError = parseRpcError(error)
		return {
			code: parsedError.code,
			message: parsedError.message,
			...(typeof parsedError.data === 'string' ? { data: parsedError.data } : {}),
		}
	}

	type SignerErrorForBackground = ReturnType<typeof normalizeSignerErrorForBackground>

	// The signer's outcome for a request that the background forwarded to it, sent back to the background as signer_reply.
	type SignerReplyToBackground<ForwardRequest extends { readonly method: string }> =
		| { readonly success: true, readonly forwardRequest: ForwardRequest, readonly reply: unknown, readonly signerProviderGeneration: number }
		| { readonly success: false, readonly forwardRequest: ForwardRequest, readonly error: SignerErrorForBackground, readonly signerProviderGeneration: number }

	type ForwardedSignerReply = SignerReplyToBackground<InterceptedRequestForwardToSigner>

	// What the background does with a signer_reply: it settles the forwarded request itself, or it answers the signer_reply request with the reply for the page request.
	type SignerReplyDelivery =
		| { readonly settledByBackground: true }
		| { readonly settledByBackground: false, readonly backgroundReply: unknown }

	function getSignerAccountsErrorReply(error: unknown, requestAccounts: boolean): SignerAccountsReply {
		if (hasErrorCodeAndMessage(error)) return { type: 'error', requestAccounts, error }
		const errorCode = getErrorCode(error)
		if (errorCode !== undefined) return { type: 'error', requestAccounts, error: { message: getFallbackErrorMessage(errorCode), code: errorCode } }
		if (error instanceof Error) return { type: 'error', requestAccounts, error: { message: error.message, code: METAMASK_ERROR_BLANKET_ERROR } }
		return { type: 'error', requestAccounts, error: { message: 'unknown error', code: METAMASK_ERROR_BLANKET_ERROR } }
	}

	function installControlledCompatibilityProperty(target: object, property: PropertyKey, getter: () => unknown, label: string) {
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

	// EIP-1193 provider state shared by the injected provider methods, the background message handler, and the compatibility properties.
	type ProviderState = {
		connected: boolean
		currentAddress: string
		activeChainId: string
	}

	// While an eth_requestAccounts resolution is pending its reply publishes the signer accounts, so forwarding of unscoped signer accountsChanged events pauses until it settles.
	type SignerAccountsRequestState = {
		pendingRequestAccountsResolution: Promise<SignerAccountsResolution> | undefined
	}

	// Bridge messaging and request/reply bookkeeping: owns the MessagePort to the content script, allocates request ids, and tracks the requests that wait for a background reply.
	function createBackgroundBridge(isUsingInterceptorWithoutSigner: () => boolean) {
		let latestRequestId = 0
		let extensionMessagePort: MessagePort | undefined
		const outstandingRequests = new Map<number, OutstandingRequest>()

		const allocateRequestId = () => {
			latestRequestId++
			return latestRequestId
		}

		const postBridgeRequest = (messageMethodAndParams: MessageMethodAndParams, requestId: number, replayOnDisconnect: boolean) => {
			if (extensionMessagePort === undefined) throw new Error('Interceptor content script bridge is not connected')
			const message: BridgeRequest = {
				type: INTERCEPTOR_BRIDGE_REQUEST_MESSAGE,
				method: messageMethodAndParams.method,
				params: messageMethodAndParams.params,
				usingInterceptorWithoutSigner: isUsingInterceptorWithoutSigner(),
				requestId,
				...(messageMethodAndParams.internal === true ? { internal: true as const } : {}),
				...(replayOnDisconnect ? { replayOnDisconnect: true as const } : {}),
			}
			extensionMessagePort.postMessage(message)
		}

		const sendRequest = async (messageMethodAndParams: MessageMethodAndParams) => {
			const requestId = allocateRequestId()
			const replayOnDisconnect = messageMethodAndParams.internal !== true && messageMethodAndParams.method === 'eth_requestAccounts'
			const reply = createDeferred<unknown>()
			outstandingRequests.set(requestId, {
				reply,
				method: messageMethodAndParams.method,
				requestScopedProviderEventCallbacks: [],
			})
			try {
				postBridgeRequest(messageMethodAndParams, requestId, replayOnDisconnect)
				return await reply.promise
			} finally {
				outstandingRequests.delete(requestId)
			}
		}

		// Notifications still consume a request id so the background's duplicate-delivery guard covers them, but they never wait for a reply: an outstanding entry would otherwise stay behind for every doNotReply answer and let a late message carrying that id reach the signer.
		const postInternalNotification = (notification: { readonly method: string, readonly params: readonly unknown[] }) => {
			postBridgeRequest({ ...notification, internal: true }, allocateRequestId(), false)
		}

		// The returned promise only reports posting failures.
		const notifyInternal = async (notification: { readonly method: InternalBackgroundNotificationMethod, readonly params: readonly unknown[] }) => {
			postInternalNotification(notification)
		}

		// The only way to send signer_reply, so a forwarded method that needs an answer can never go out as a notification. The background settles FORWARDED_METHODS_SETTLED_BY_BACKGROUND itself and never answers their signer_reply, so those are notifications; every other method is a request whose answer the caller uses to settle the page request.
		const sendSignerReply = async <ForwardRequest extends { readonly method: string }>(signerReply: SignerReplyToBackground<ForwardRequest>): Promise<SignerReplyDelivery> => {
			const message = { method: 'signer_reply', params: [signerReply] }
			if (FORWARDED_METHODS_SETTLED_BY_BACKGROUND.has(signerReply.forwardRequest.method)) {
				postInternalNotification(message)
				return { settledByBackground: true }
			}
			return { settledByBackground: false, backgroundReply: await sendRequest({ ...message, internal: true }) }
		}

		const reportInterceptorError = (diagnostics: string) => {
			try {
				if (extensionMessagePort === undefined) return
				postBridgeRequest({ method: 'InterceptorError', params: [diagnostics], internal: true }, -1, false)
			} catch (reportingError: unknown) {
				// error-reporting: console-only. This is the inpage's only reporting channel, so its own failure can only reach the page console.
				console.error('Failed to report InterceptorError diagnostics')
				console.error(reportingError)
			}
		}

		const drainRequestScopedProviderEventCallbacks = (requestId: number) => {
			const outstandingRequest = outstandingRequests.get(requestId)
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

		return {
			connect: (onMessage: (messageEvent: MessageEvent<unknown>) => Promise<void>) => {
				const channel = new MessageChannel()
				extensionMessagePort = channel.port1
				channel.port1.onmessage = (messageEvent: MessageEvent<unknown>) => { void onMessage(messageEvent) }
				window.postMessage({ type: INTERCEPTOR_BRIDGE_PORT_MESSAGE }, '*', [channel.port2])
			},
			request: (methodAndParams: Omit<MessageMethodAndParams, 'internal'>) => sendRequest(methodAndParams),
			requestInternal: (request: { readonly method: InternalBackgroundRequestMethod, readonly params: readonly unknown[] }) => sendRequest({ ...request, internal: true }),
			notifyInternal,
			sendSignerReply,
			reportInterceptorError,
			getOutstandingRequest: (requestId: number) => outstandingRequests.get(requestId),
			// Events the background replays for one request are delivered just before that request resolves, and dropped once it has settled.
			queueRequestScopedProviderEvent: (requestId: number, notifyProviderEvent: () => void) => {
				outstandingRequests.get(requestId)?.requestScopedProviderEventCallbacks?.push(notifyProviderEvent)
			},
			resolveWithRequestScopedProviderEvents: (requestId: number, value: unknown) => {
				const callbackError = drainRequestScopedProviderEventCallbacks(requestId)
				outstandingRequests.get(requestId)?.reply.resolve(value)
				if (callbackError !== undefined) throw callbackError
			},
		}
	}

	type BackgroundBridge = ReturnType<typeof createBackgroundBridge>

	// EIP-1193 provider event emission: the page's on/removeListener registrations and the events delivered to them.
	function createProviderEventEmitter() {
		const listeners = {
			message: new Set<AnyCallBack>(),
			connect: new Set<AnyCallBack>(),
			accountsChanged: new Set<AnyCallBack>(),
			disconnect: new Set<AnyCallBack>(),
			chainChanged: new Set<AnyCallBack>(),
		}

		const getListeners = (kind: OnMessage) => {
			switch (kind) {
				case 'accountsChanged': return listeners.accountsChanged
				case 'message': return listeners.message
				case 'connect': return listeners.connect
				// close is deprecated on eip-1193 by disconnect but its still used by dapps (MyEtherWallet)
				case 'close': return listeners.disconnect
				case 'disconnect': return listeners.disconnect
				case 'chainChanged': return listeners.chainChanged
				default: return exhaustivenessCheck(kind)
			}
		}

		// Listeners are untyped page functions, so they are invoked through Reflect.apply. Payloads are created per listener, which keeps message, connect, and disconnect payloads independent between listeners; creating one stays outside the try, so a malformed background payload still reaches the Interceptor's error reporting.
		const emit = (eventListeners: ReadonlySet<AnyCallBack>, createPayload: () => unknown) => {
			for (const listener of eventListeners) {
				const payload = createPayload()
				try {
					Reflect.apply(listener, undefined, [payload])
				} catch (listenerError: unknown) {
					// Like MetaMask's SafeEventEmitter: a throwing dapp listener must not skip the listeners after it or be reported as an Interceptor error, so its error is rethrown from a timer, where the page sees it as its own uncaught error.
					setTimeout(() => { throw listenerError }, 0)
				}
			}
		}

		return {
			addListener: (kind: OnMessage, listener: AnyCallBack) => { getListeners(kind)?.add(listener) },
			removeListener: (kind: OnMessage, listener: AnyCallBack) => { getListeners(kind)?.delete(listener) },
			emitSubscriptionMessage: (data: unknown) => emit(listeners.message, () => ({ type: 'eth_subscription', data })),
			emitConnect: (connectResult: unknown) => emit(listeners.connect, () => getProviderConnectInfo(connectResult)),
			emitAccountsChanged: (accounts: readonly string[]) => emit(listeners.accountsChanged, () => accounts),
			emitDisconnect: () => emit(listeners.disconnect, () => ({ name: 'disconnect', code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Provider disconnected from all chains.' })),
			emitChainChanged: (chainId: string) => emit(listeners.chainChanged, () => chainId),
		}
	}

	type ProviderEventEmitter = ReturnType<typeof createProviderEventEmitter>

	// MetaMask and legacy compatibility properties: window.ethereum.isMetaMask, selectedAddress, chainId, networkVersion, and window.web3 for dapps that read them synchronously.
	function createMetaMaskCompatibility(providerState: ProviderState) {
		let enabled = false
		let ethereumSelectedAddressControlled = false
		let web3AccountsControlled = false

		const getControlledSelectedAddress = () => providerState.currentAddress === '' ? undefined : providerState.currentAddress

		const getControlledAccounts = () => providerState.currentAddress === '' ? [] : [providerState.currentAddress]

		const refreshAccountCompatibilityProperties = (accounts: readonly string[]) => {
			const address = accounts[0] ?? ''
			if (enabled && inpageWindow.ethereum !== undefined && !ethereumSelectedAddressControlled) {
				setCompatibilityProperty(inpageWindow.ethereum, 'selectedAddress', address, 'window.ethereum.selectedAddress')
			}
			const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (enabled && legacyWeb3 !== undefined && !web3AccountsControlled) {
				setCompatibilityProperty(legacyWeb3, 'accounts', accounts, 'window.web3.accounts')
			}
		}

		const hasNonConfigurableAccountCompatibilityProperty = () => {
			if (inpageWindow.ethereum !== undefined && Object.getOwnPropertyDescriptor(inpageWindow.ethereum, 'selectedAddress')?.configurable === false) return true
			const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (legacyWeb3 !== undefined && Object.getOwnPropertyDescriptor(legacyWeb3, 'accounts')?.configurable === false) return true
			return false
		}

		const installControlledAccountCompatibilityProperties = () => {
			if (inpageWindow.ethereum !== undefined) {
				ethereumSelectedAddressControlled = installControlledCompatibilityProperty(inpageWindow.ethereum, 'selectedAddress', getControlledSelectedAddress, 'window.ethereum.selectedAddress')
			}
			const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (legacyWeb3 !== undefined) {
				if (Object.getOwnPropertyDescriptor(legacyWeb3, 'accounts')?.configurable === false) {
					setCompatibilityProperty(inpageWindow, 'web3', { accounts: getControlledAccounts(), currentProvider: inpageWindow.ethereum }, 'window.web3')
				}
				const controlledLegacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
				if (controlledLegacyWeb3 === undefined) return
				web3AccountsControlled = installControlledCompatibilityProperty(controlledLegacyWeb3, 'accounts', getControlledAccounts, 'window.web3.accounts')
				setCompatibilityProperty(controlledLegacyWeb3, 'currentProvider', inpageWindow.ethereum, 'window.web3.currentProvider')
			}
		}

		const setChainCompatibilityProperties = (ethereum: WindowEthereum, chainId: string) => {
			setCompatibilityProperty(ethereum, 'chainId', chainId, 'window.ethereum.chainId')
			setCompatibilityProperty(ethereum, 'networkVersion', chainIdToNetworkVersion(chainId), 'window.ethereum.networkVersion')
		}

		const setEnabled = (enable: boolean) => {
			enabled = enable
			if (!enable) return
			if (inpageWindow.ethereum === undefined) return
			// Compatibility mode exists so dapps that only accept MetaMask work, so window.ethereum always reports isMetaMask: true, also over a wallet that reports false itself. This applies to both injection paths: the Interceptor wrapper provider, and a wallet provider that the Interceptor methods were assigned onto.
			setCompatibilityProperty(inpageWindow.ethereum, 'isMetaMask', true, 'window.ethereum.isMetaMask')
			const legacyWeb3 = getLegacyWeb3WithoutInvokingAccessors(inpageWindow)
			if (legacyWeb3 !== undefined) {
				setCompatibilityProperty(legacyWeb3, 'currentProvider', inpageWindow.ethereum, 'window.web3.currentProvider')
			} else {
				setCompatibilityProperty(inpageWindow, 'web3', { accounts: [], currentProvider: inpageWindow.ethereum }, 'window.web3')
			}
			installControlledAccountCompatibilityProperties()
		}

		return {
			isEnabled: () => enabled,
			setEnabled,
			refreshAccountCompatibilityProperties,
			hasNonConfigurableAccountCompatibilityProperty,
			installControlledAccountCompatibilityProperties,
			setChainCompatibilityProperties,
		}
	}

	type MetaMaskCompatibility = ReturnType<typeof createMetaMaskCompatibility>

	// Signer selection: the wallet provider currently used for signing, and the generation counter that marks replies from a replaced provider as stale.
	function createSignerSelection() {
		let signerName: Signer = 'NoSigner'
		let signerProvider: WindowEthereum | undefined
		let signerRequest: EthereumRequest | undefined
		let fallbackSignerRequest: EthereumRequest | undefined
		let signerProviderGeneration = 0
		const signerProviderChangeWaiters = new Set<Deferred<void>>()

		const advanceSignerProviderGeneration = () => {
			signerProviderGeneration++
			for (const waiter of signerProviderChangeWaiters) waiter.resolve(undefined)
			signerProviderChangeWaiters.clear()
			return signerProviderGeneration
		}

		const setSignerProvider = (provider: WindowEthereum | undefined, request: EthereumRequest | undefined, fallbackRequest?: EthereumRequest) => {
			if (signerProvider !== provider) advanceSignerProviderGeneration()
			signerProvider = provider
			signerRequest = request
			fallbackSignerRequest = fallbackRequest
		}

		const requestFromSigner = async (methodAndParams: { readonly method: string, readonly params?: EthereumRequestParameters }, allowRequestAccountsFallbackToRoot: boolean) => {
			const request = signerRequest
			if (request === undefined) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
			try {
				return await request(methodAndParams)
			} catch (error: unknown) {
				const fallbackRequest = fallbackSignerRequest
				if (!allowRequestAccountsFallbackToRoot || fallbackRequest === undefined) throw error
				if (methodAndParams.method === 'eth_accounts') throw error
				if (!canFallbackRequestToRootSigner(methodAndParams.method)) throw error
				if (isUserRejectedRequestError(error)) throw error
				return await fallbackRequest(methodAndParams)
			}
		}

		const requestFromCurrentSigner = async (methodAndParams: { readonly method: string, readonly params?: EthereumRequestParameters }, allowRequestAccountsFallbackToRoot = false): Promise<SignerProviderRequestOutcome> => {
			const requestGeneration = signerProviderGeneration
			const providerChange = createDeferred<void>()
			signerProviderChangeWaiters.add(providerChange)
			const signerReply: Promise<SignerProviderRequestOutcome> = requestFromSigner(methodAndParams, allowRequestAccountsFallbackToRoot).then(
				(reply): SignerProviderRequestOutcome => ({ type: 'success', reply, signerProviderGeneration: requestGeneration }),
				(error: unknown): SignerProviderRequestOutcome => ({ type: 'error', error, signerProviderGeneration: requestGeneration }),
			)
			const providerChanged = providerChange.promise.then((): SignerProviderRequestOutcome => ({ type: 'providerChanged', signerProviderGeneration: requestGeneration }))
			try {
				const outcome = await Promise.race([signerReply, providerChanged])
				if (requestGeneration !== signerProviderGeneration) return { type: 'providerChanged', signerProviderGeneration: requestGeneration }
				return outcome
			} finally {
				signerProviderChangeWaiters.delete(providerChange)
			}
		}

		return {
			getSignerName: () => signerName,
			setSignerName: (name: Signer) => { signerName = name },
			getSignerProvider: () => signerProvider,
			hasSigner: () => signerRequest !== undefined,
			getSignerProviderGeneration: () => signerProviderGeneration,
			advanceSignerProviderGeneration,
			setSignerProvider,
			requestFromCurrentSigner,
		}
	}

	type SignerSelection = ReturnType<typeof createSignerSelection>

	// Signer discovery and connection tracking: finds a usable wallet provider (legacy provider lists, EIP-6963 MetaMask announcements, late wallets), follows its events, and reports the selected signer, its chain, and its account changes to the background.
	function createSignerConnection({ bridge, compatibility, selection, providerState, signerAccountsRequestState }: {
		readonly bridge: BackgroundBridge
		readonly compatibility: MetaMaskCompatibility
		readonly selection: SignerSelection
		readonly providerState: ProviderState
		readonly signerAccountsRequestState: SignerAccountsRequestState
	}) {
		let announcedMetaMaskUuid: string | undefined
		let acceptingAnnouncedMetaMaskProviders = false
		let signerSelectionGeneration = 0
		let latestSignerConnectionTransition: Promise<void> = Promise.resolve()
		let signerDiscoveryRetryTimer: ReturnType<typeof setTimeout> | undefined
		const subscribedSignerProviders = new WeakSet<object>()
		const rejectedSignerProviders = new WeakSet<object>()
		const signerConnectionTransitionChangeWaiters = new Set<Deferred<void>>()
		const signerAvailabilityWaiters = new Set<Deferred<void>>()
		const metaMaskAvailabilityWaiters = new Set<Deferred<void>>()

		const reportSignerDiscoveryError = (phase: string, error: unknown) => {
			bridge.reportInterceptorError(serializeForwardedDiagnostics('inpage', phase, error))
		}

		const subscribeToSignerEvents = (provider: WindowEthereum, signerName: Signer, signerOn = provider.on.bind(provider), signerRemoveListener = provider.removeListener.bind(provider)) => {
			if (subscribedSignerProviders.has(provider)) return
			const registrations: { readonly kind: OnMessage, readonly callback: AnyCallBack }[] = []
			const register = (kind: OnMessage, callback: AnyCallBack) => {
				registrations.push({ kind, callback })
				signerOn(kind, callback)
			}
			try {
				register('accountsChanged', (accounts: readonly string[]) => {
					if (selection.getSignerProvider() !== provider) return
					if (!Array.isArray(accounts)) return
					if (!isStringArray([...accounts])) return
					const signerAccounts = [...accounts]
					if (signerAccountsRequestState.pendingRequestAccountsResolution !== undefined) return
					bridge.notifyInternal({ method: 'eth_accounts_reply', params: [{ type: 'success', accounts: signerAccounts, requestAccounts: false, signerProviderGeneration: selection.getSignerProviderGeneration() }] })
				})
				register('connect', (_connectInfo: ProviderConnectInfo) => {
					if (selection.getSignerProvider() !== provider) return
					connectToSigner(signerName)
				})
				register('disconnect', (_error: ProviderRpcError) => {
					if (selection.getSignerProvider() !== provider) return
					const signerProviderGeneration = selection.advanceSignerProviderGeneration()
					bridge.requestInternal({ method: 'connected_to_signer', params: [false, signerName, signerProviderGeneration] })
				})
				register('chainChanged', (chainId: string) => {
					if (selection.getSignerProvider() !== provider) return
					const params = [normalizeSignerChainId(chainId), selection.getSignerProviderGeneration()]
					bridge.notifyInternal({ method: 'signer_chainChanged', params })
				})
				subscribedSignerProviders.add(provider)
			} catch (error: unknown) {
				rejectedSignerProviders.add(provider)
				for (const registration of registrations.reverse()) {
					try {
						signerRemoveListener(registration.kind, registration.callback)
					} catch (rollbackError: unknown) {
						rejectedSignerProviders.add(provider)
						reportSignerDiscoveryError('roll back signer event subscription', rollbackError)
					}
				}
				throw error
			}
		}

		const trySubscribeToSignerEvents = (provider: WindowEthereum, signerName: Signer, signerOn = provider.on.bind(provider), signerRemoveListener = provider.removeListener.bind(provider)) => {
			if (rejectedSignerProviders.has(provider)) return false
			try {
				subscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)
				return true
			} catch (error: unknown) {
				reportSignerDiscoveryError('subscribe to signer events', error)
				return false
			}
		}

		const prepareSignerProvider = (provider: unknown, signerName: Signer, requireMetaMaskMarker = false, requireMetaMaskConsistency = true) => {
			try {
				if (!hasUsableSignerInterface(provider)) return undefined
				if (requireMetaMaskMarker && provider.isMetaMask !== true) return undefined
				if (requireMetaMaskConsistency && !hasNoConflictingWalletMarkers(provider)) return undefined
				const request = provider.request.bind(provider)
				const signerOn = provider.on.bind(provider)
				const signerRemoveListener = provider.removeListener.bind(provider)
				const connected = provider.isConnected === undefined || provider.isConnected()
				if (!trySubscribeToSignerEvents(provider, signerName, signerOn, signerRemoveListener)) return undefined
				return { provider, connected, request }
			} catch (error: unknown) {
				reportSignerDiscoveryError('prepare signer provider', error)
				return undefined
			}
		}

		const adoptAnnouncedMetaMaskProvider = (event: Event) => {
			if (!acceptingAnnouncedMetaMaskProviders) return
			let announcement: ReturnType<typeof getEip6963MetaMaskAnnouncement>
			try {
				announcement = getEip6963MetaMaskAnnouncement(event)
			} catch (error: unknown) {
				reportSignerDiscoveryError('read EIP-6963 MetaMask announcement', error)
				return
			}
			if (announcement === undefined) return
			const { provider, info } = announcement
			if (provider === selection.getSignerProvider()) return
			if (announcedMetaMaskUuid !== undefined) return
			if (!canAnnouncedMetaMaskReplaceSigner(selection.getSignerName())) return
			const preparedSigner = prepareSignerProvider(provider, 'MetaMask')
			if (preparedSigner === undefined) return
			announcedMetaMaskUuid = info.uuid
			selection.setSignerProvider(preparedSigner.provider, preparedSigner.request)
			providerState.connected = preparedSigner.connected
			connectToSigner('MetaMask')
		}

		const discoverAnnouncedMetaMaskProvider = () => {
			if (acceptingAnnouncedMetaMaskProviders) return
			window.addEventListener('eip6963:announceProvider', adoptAnnouncedMetaMaskProvider)
			acceptingAnnouncedMetaMaskProviders = true
			try {
				window.dispatchEvent(new Event('eip6963:requestProvider'))
			} catch (error: unknown) {
				reportSignerDiscoveryError('request EIP-6963 signer providers', error)
			} finally {
				acceptingAnnouncedMetaMaskProviders = false
				window.removeEventListener('eip6963:announceProvider', adoptAnnouncedMetaMaskProvider)
			}
		}

		const stopSignerDiscoveryRetries = () => {
			if (signerDiscoveryRetryTimer === undefined) return
			clearTimeout(signerDiscoveryRetryTimer)
			signerDiscoveryRetryTimer = undefined
		}

		const isWaitingForSignerDiscovery = () => {
			const waitingForAnySigner = signerAvailabilityWaiters.size > 0 && !selection.hasSigner()
			const waitingForMetaMaskInsteadOfBrave = metaMaskAvailabilityWaiters.size > 0 && selection.getSignerName() === 'Brave'
			return waitingForAnySigner || waitingForMetaMaskInsteadOfBrave
		}

		const scheduleSignerDiscoveryRetry = () => {
			if (signerDiscoveryRetryTimer !== undefined || !isWaitingForSignerDiscovery()) return
			// A late wallet may start answering EIP-6963 requests without successfully replacing window.ethereum or dispatching ethereum#initialized.
			signerDiscoveryRetryTimer = setTimeout(() => {
				signerDiscoveryRetryTimer = undefined
				if (!isWaitingForSignerDiscovery()) return
				discoverAnnouncedMetaMaskProvider()
				scheduleSignerDiscoveryRetry()
			}, SIGNER_DISCOVERY_RETRY_INTERVAL_MS)
		}

		const waitForSignerAvailability = async () => {
			if (selection.getSignerName() === 'NoSigner' || selection.getSignerName() === 'Brave') discoverAnnouncedMetaMaskProvider()
			const waitForMetaMaskInsteadOfBrave = selection.getSignerName() === 'Brave'
			if (selection.hasSigner() && !waitForMetaMaskInsteadOfBrave) return true

			const signerAvailability = createDeferred<void>()
			const waiters = waitForMetaMaskInsteadOfBrave ? metaMaskAvailabilityWaiters : signerAvailabilityWaiters
			waiters.add(signerAvailability)
			scheduleSignerDiscoveryRetry()
			let timeout: ReturnType<typeof setTimeout> | undefined
			try {
				await Promise.race([
					signerAvailability.promise,
					new Promise<void>((resolve) => { timeout = setTimeout(resolve, SIGNER_DISCOVERY_TIMEOUT_MS) }),
				])
			} finally {
				waiters.delete(signerAvailability)
				if (signerAvailabilityWaiters.size === 0 && metaMaskAvailabilityWaiters.size === 0) stopSignerDiscoveryRetries()
				if (timeout !== undefined) clearTimeout(timeout)
			}
			return selection.hasSigner()
		}

		const findPreparedLegacyMetaMaskProvider = (injectedWindowEthereum: WindowEthereum) => {
			let providers: readonly unknown[] | undefined
			try {
				const possibleProviders = injectedWindowEthereum.providers
				if (Array.isArray(possibleProviders)) providers = possibleProviders
			} catch (error: unknown) {
				reportSignerDiscoveryError('read legacy signer providers', error)
				return undefined
			}
			if (providers === undefined) return undefined
			let providerCount = 0
			try {
				providerCount = providers.length
			} catch (error: unknown) {
				reportSignerDiscoveryError('read legacy signer provider count', error)
				return undefined
			}
			for (let providerIndex = 0; providerIndex < providerCount; providerIndex++) {
				let provider: unknown
				try {
					provider = providers[providerIndex]
				} catch (error: unknown) {
					reportSignerDiscoveryError('read legacy signer provider', error)
					continue
				}
				if (provider === injectedWindowEthereum) continue
				const preparedSigner = prepareSignerProvider(provider, 'MetaMask', true)
				if (preparedSigner !== undefined) return preparedSigner
			}
			return undefined
		}

		const requestChainIdFromSigner = async () => {
			if (!selection.hasSigner()) return
			const outcome = await selection.requestFromCurrentSigner({ method: 'eth_chainId', params: [] })
			if (outcome.type === 'providerChanged') return
			if (outcome.type === 'success') {
				const reply = outcome.reply
				if (typeof reply !== 'string') {
					bridge.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', new Error('Signer eth_chainId returned a non-string reply.'), { requestMethod: 'eth_chainId' }))
					return
				}
				await bridge.notifyInternal({ method: 'signer_chainChanged', params: [reply, outcome.signerProviderGeneration] })
				return
			}
			console.error('failed to get chain Id from signer')
			console.error(outcome.error)
			bridge.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'request signer chain id', outcome.error, { requestMethod: 'eth_chainId' }))
		}

		const connectToSigner = (signerName: Signer) => {
			selection.setSignerName(signerName)
			const signerProviderGeneration = selection.advanceSignerProviderGeneration()
			if (selection.hasSigner()) {
				for (const waiter of signerAvailabilityWaiters) waiter.resolve(undefined)
				signerAvailabilityWaiters.clear()
				if (signerName === 'MetaMask') {
					for (const waiter of metaMaskAvailabilityWaiters) waiter.resolve(undefined)
					metaMaskAvailabilityWaiters.clear()
				}
				if (signerAvailabilityWaiters.size === 0 && metaMaskAvailabilityWaiters.size === 0) stopSignerDiscoveryRetries()
			}
			signerSelectionGeneration++
			const selectionGeneration = signerSelectionGeneration
			const reportSignerConnection = async (): Promise<{ metamaskCompatibilityMode: boolean }> => {
				const connectSignerReply = await bridge.requestInternal({ method: 'connected_to_signer', params: [signerName !== 'NoSigner', signerName, signerProviderGeneration] })
				if (typeof connectSignerReply === 'object' && connectSignerReply !== null
					&& 'metamaskCompatibilityMode' in connectSignerReply && typeof connectSignerReply.metamaskCompatibilityMode === 'boolean') {
					return { metamaskCompatibilityMode: connectSignerReply.metamaskCompatibilityMode }
				}
				throw new Error('Failed to parse connected_to_signer reply')
			}

			const completeTransition = async () => {
				const connection = await reportSignerConnection()
				if (selectionGeneration !== signerSelectionGeneration) return
				compatibility.setEnabled(connection.metamaskCompatibilityMode)
				// Account replies only require confirmed provider identity; chain initialization must not hold them back.
				if (signerName !== 'NoSigner') void requestChainIdFromSigner().catch((error: unknown) => {
					// Use the same discovery diagnostic helper as provider selection and account initialization.
					reportSignerDiscoveryError('initialize signer chain', error)
				})
			}
			// A fresh status report must not wait behind an older bridge request whose reply may have been lost during a background-worker or content-port replacement. The generation checks on both sides make late replies from superseded reports harmless.
			const transition = completeTransition().catch((error: unknown) => {
				reportSignerDiscoveryError('report signer connection status', error)
			})
			latestSignerConnectionTransition = transition
			for (const waiter of signerConnectionTransitionChangeWaiters) waiter.resolve(undefined)
			signerConnectionTransitionChangeWaiters.clear()
			return transition
		}

		const waitForLatestSignerConnectionTransition = async () => {
			for (;;) {
				const transition = latestSignerConnectionTransition
				const transitionChanged = createDeferred<void>()
				signerConnectionTransitionChangeWaiters.add(transitionChanged)
				try {
					await Promise.race([transition, transitionChanged.promise])
				} finally {
					signerConnectionTransitionChangeWaiters.delete(transitionChanged)
				}
				if (transition !== latestSignerConnectionTransition) continue
				await transition
				return
			}
		}

		return {
			reportSignerDiscoveryError,
			prepareSignerProvider,
			findPreparedLegacyMetaMaskProvider,
			discoverAnnouncedMetaMaskProvider,
			waitForSignerAvailability,
			connectToSigner,
			waitForLatestSignerConnectionTransition,
			requestChainIdFromSigner,
		}
	}

	type SignerConnection = ReturnType<typeof createSignerConnection>

	// Signer accounts: answers the background's account requests with the selected signer's accounts and retries when the signer changes before the answer is published.
	function createSignerAccounts({ bridge, selection, signerConnection, signerAccountsRequestState }: {
		readonly bridge: BackgroundBridge
		readonly selection: SignerSelection
		readonly signerConnection: SignerConnection
		readonly signerAccountsRequestState: SignerAccountsRequestState
	}) {
		const resolveSignerAccountsFromCurrentProvider = async (requestAccounts: boolean): Promise<SignerAccountsResolution> => {
			for (;;) {
				const signerAvailable = await signerConnection.waitForSignerAvailability()
				const signerProviderGeneration = selection.getSignerProviderGeneration()
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
				const outcome = await selection.requestFromCurrentSigner({ method, params: [] }, requestAccounts)
				if (outcome.type === 'providerChanged') continue
				if (outcome.type === 'error') return { signerProviderGeneration: outcome.signerProviderGeneration, reply: getSignerAccountsErrorReply(outcome.error, requestAccounts) }
				const reply = outcome.reply
				if (!Array.isArray(reply)) return { signerProviderGeneration, reply: getSignerAccountsErrorReply(new Error('Signer returned something else than an array'), requestAccounts) }
				if (!isStringArray(reply)) return { signerProviderGeneration, reply: getSignerAccountsErrorReply(new Error('Signer did not return a string array'), requestAccounts) }
				return { signerProviderGeneration, reply: { type: 'success', accounts: reply, requestAccounts } }
			}
		}

		const sendSignerAccountsResolution = async (resolution: SignerAccountsResolution) => {
			await signerConnection.waitForLatestSignerConnectionTransition()
			if (resolution.signerProviderGeneration !== selection.getSignerProviderGeneration()) return false
			await bridge.notifyInternal({ method: 'eth_accounts_reply', params: [{ ...resolution.reply, signerProviderGeneration: resolution.signerProviderGeneration }] })
			return true
		}

		const getSharedSignerAccountsResolution = async () => {
			const existingRequest = signerAccountsRequestState.pendingRequestAccountsResolution
			if (existingRequest !== undefined) return await existingRequest
			const pendingRequest = resolveSignerAccountsFromCurrentProvider(true)
			signerAccountsRequestState.pendingRequestAccountsResolution = pendingRequest
			try {
				return await pendingRequest
			} finally {
				if (signerAccountsRequestState.pendingRequestAccountsResolution === pendingRequest) signerAccountsRequestState.pendingRequestAccountsResolution = undefined
			}
		}

		return {
			// attempts to call signer for eth_accounts
			getAccountsFromSigner: async () => {
				for (;;) {
					const resolution = await resolveSignerAccountsFromCurrentProvider(false)
					if (await sendSignerAccountsResolution(resolution)) return
				}
			},
			// attempts to call signer for eth_requestAccounts
			requestAccountsFromSigner: async () => {
				for (;;) {
					const resolution = await getSharedSignerAccountsResolution()
					if (await sendSignerAccountsResolution(resolution)) return
				}
			},
		}
	}

	type SignerAccounts = ReturnType<typeof createSignerAccounts>

	// Signer requests: runs the wallet actions the background delegates to the selected signer (chain switches, watch-asset, forwarded RPC requests) and reports their outcome back.
	function createSignerRequests(bridge: BackgroundBridge, selection: SignerSelection) {
		const requestChangeChainFromSigner = async (chainId: string, walletSwitchRequestId: string) => {
			if (!selection.hasSigner()) {
				await bridge.notifyInternal({
					method: 'wallet_switchEthereumChain_reply',
					params: [{
						accept: false,
						chainId, walletSwitchRequestId,
						signerProviderGeneration: selection.getSignerProviderGeneration(),
						error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
					}],
				})
				return
			}

			const outcome = await selection.requestFromCurrentSigner({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
			if (outcome.type === 'success') {
				const params = outcome.reply === null
					? { accept: true as const, chainId, walletSwitchRequestId, signerProviderGeneration: outcome.signerProviderGeneration }
					: {
						accept: false as const,
						chainId, walletSwitchRequestId,
						signerProviderGeneration: outcome.signerProviderGeneration,
						error: { code: METAMASK_ERROR_BLANKET_ERROR, message: 'Signer returned an invalid wallet_switchEthereumChain reply.' },
					}
				await bridge.notifyInternal({ method: 'wallet_switchEthereumChain_reply', params: [params] })
				return
			}
			const error = outcome.type === 'providerChanged'
				? { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' }
				: normalizeSignerErrorForBackground(outcome.error)
			await bridge.notifyInternal({
				method: 'wallet_switchEthereumChain_reply',
				params: [{ accept: false, chainId, walletSwitchRequestId, error, signerProviderGeneration: outcome.signerProviderGeneration }],
			})
		}

		const requestWatchAssetFromSigner = async (parameters: unknown) => {
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
			if (!selection.hasSigner() || selection.getSignerProviderGeneration() !== parameters.signerIdentity.signerProviderGeneration) {
				await bridge.sendSignerReply({
					success: false,
					forwardRequest,
					error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the watch-asset request reached the wallet.' },
					signerProviderGeneration: parameters.signerIdentity.signerProviderGeneration,
				})
				return
			}
			const outcome = await selection.requestFromCurrentSigner({ method: 'wallet_watchAsset', params: walletParameters })
			const signerReply: SignerReplyToBackground<typeof forwardRequest> = outcome.type === 'success'
				? { success: true, forwardRequest, reply: outcome.reply, signerProviderGeneration: outcome.signerProviderGeneration }
				: {
					success: false,
					forwardRequest,
					error: outcome.type === 'error'
						? normalizeSignerErrorForBackground(outcome.error)
						: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' },
					signerProviderGeneration: outcome.signerProviderGeneration,
				}
			await bridge.sendSignerReply(signerReply)
		}

		const requestForwardedSignerReply = async (forwardRequest: InterceptedRequestForwardToSigner): Promise<ForwardedSignerReply> => {
			const outcome = await selection.requestFromCurrentSigner({ method: forwardRequest.method, params: 'params' in forwardRequest ? forwardRequest.params : [] })
			if (outcome.type === 'success') return { success: true, forwardRequest, reply: outcome.reply, signerProviderGeneration: outcome.signerProviderGeneration }
			if (outcome.type === 'error') return { success: false, forwardRequest, error: normalizeSignerErrorForBackground(outcome.error), signerProviderGeneration: outcome.signerProviderGeneration }
			return {
				success: false,
				forwardRequest,
				error: { code: METAMASK_ERROR_PROVIDER_DISCONNECTED, message: 'Signer connection changed before the previous wallet replied.' },
				signerProviderGeneration: outcome.signerProviderGeneration,
			}
		}

		// Signing and watch-asset requests are settled by the background, which never answers their signer_reply. Any other forwarded method is answered on the signer_reply request, and that answer settles the page request.
		const sendForwardedSignerReply = async (signerReply: ForwardedSignerReply, forwardedRequest: OutstandingRequest) => {
			const delivery = await bridge.sendSignerReply(signerReply)
			if (!delivery.settledByBackground) forwardedRequest.reply.resolve(delivery.backgroundReply)
		}

		return { requestChangeChainFromSigner, requestWatchAssetFromSigner, requestForwardedSignerReply, sendForwardedSignerReply }
	}

	type SignerRequests = ReturnType<typeof createSignerRequests>

	// EIP-1193 provider methods: the request, legacy send/sendAsync, and event registration API that the injected window.ethereum exposes to the page.
	function createInterceptorProviderMethods({ bridge, providerEvents, compatibility, providerState }: {
		readonly bridge: BackgroundBridge
		readonly providerEvents: ProviderEventEmitter
		readonly compatibility: MetaMaskCompatibility
		readonly providerState: ProviderState
	}) {
		const WindowEthereumIsConnected = () => providerState.connected

		// sends a message to interceptors background script
		const WindowEthereumRequest = async (methodAndParams: { readonly method: string, readonly params?: InterceptorEthereumRequestParameters }) => {
			try {
				if (isInternalBackgroundMethod(methodAndParams.method)) throw new EthereumJsonRpcError(METAMASK_METHOD_NOT_SUPPORTED, `Method not supported: ${ methodAndParams.method }`)
				const params = normalizeInterceptorEthereumRequestParameters(methodAndParams.method, methodAndParams.params)
				// make a message that the background script will catch and reply us. We'll wait until the background script replies to us and return only after that
				return await bridge.request({
					method: methodAndParams.method,
					...(params !== undefined ? { params } : {}),
				})
			} catch (error: unknown) {
				if (error instanceof Error) throw error
				throw new EthereumJsonRpcError(METAMASK_ERROR_BLANKET_ERROR, 'Unexpected thrown value.', { error: error, request: methodAndParams })
			}
		}

		const getWindowEthereumSendAsyncResponse = async (param: SingleSendAsyncParam): Promise<JsonRpcResponse> => {
			try {
				const result = await WindowEthereumRequest(param)
				return { jsonrpc: '2.0', id: param.id, result }
			} catch (error) {
				if (hasErrorCodeAndMessage(error)) {
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

		const WindowEthereumSendAsync = async (payload: SingleSendAsyncParam | SingleSendAsyncParam[], callback: LegacyJsonRpcCallback) => {
			let response: JsonRpcResponse | JsonRpcResponse[]
			try {
				response = Array.isArray(payload)
					? await Promise.all(payload.map((param) => getWindowEthereumSendAsyncResponse(param)))
					: await getWindowEthereumSendAsyncResponse(payload)
			} catch (error: unknown) {
				callback(error instanceof Error ? error : new Error(`Unexpected sendAsync failure: ${ String(error) }`), null)
				return
			}
			callback(null, response)
		}

		const WindowEthereumSend = (payload: { readonly id: string | number | null, readonly method: string, readonly params: readonly unknown[] } | string, maybeCallBack: undefined | LegacyJsonRpcCallback) => {
			const fullPayload = typeof payload === 'string' ? { method: payload, id: 1, params: [] } : payload
			if (maybeCallBack !== undefined && typeof maybeCallBack === 'function') return WindowEthereumSendAsync(fullPayload, maybeCallBack)
			if (compatibility.isEnabled()) {
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

		const WindowEthereumOn = (kind: OnMessage, callback: AnyCallBack) => {
			if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
			providerEvents.addListener(kind, callback)
			return inpageWindow.ethereum
		}

		const WindowEthereumRemoveListener = (kind: OnMessage, callback: AnyCallBack) => {
			if (inpageWindow.ethereum === undefined) throw new Error('window.ethereum is not defined')
			providerEvents.removeListener(kind, callback)
			return inpageWindow.ethereum
		}

		const WindowEthereumEnable = async () => WindowEthereumRequest({ method: 'eth_requestAccounts' })

		const unsupportedMethods = (windowEthereum: WindowEthereum & UnsupportedWindowEthereumMethods | undefined) => {
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
						return providerState.connected
					}),
					requestBatch: async () => { return unsupportedError('window.ethereum._metamask.requestBatch()') }
				}
			}
		}

		// Binding gives every injected provider its own function objects; the arrow implementations ignore the bound receiver.
		const createInterceptorProvider = (signerWindowEthereum: WindowEthereum | undefined): WindowEthereum => {
			return {
				isInterceptor: true,
				isConnected: WindowEthereumIsConnected.bind(signerWindowEthereum),
				request: WindowEthereumRequest.bind(signerWindowEthereum),
				send: WindowEthereumSend.bind(signerWindowEthereum),
				sendAsync: WindowEthereumSendAsync.bind(signerWindowEthereum),
				on: WindowEthereumOn.bind(signerWindowEthereum),
				removeListener: WindowEthereumRemoveListener.bind(signerWindowEthereum),
				enable: WindowEthereumEnable.bind(signerWindowEthereum),
				...unsupportedMethods(signerWindowEthereum),
			}
		}

		return { request: WindowEthereumRequest, createInterceptorProvider }
	}

	type InterceptorProviderMethods = ReturnType<typeof createInterceptorProviderMethods>

	// Background messages: applies the provider events, request replies, and signer commands that the content script relays from the background.
	function createBackgroundMessageHandler({ bridge, providerEvents, providerState, compatibility, selection, signerConnection, signerAccounts, signerRequests, safeAppsBridge }: {
		readonly bridge: BackgroundBridge
		readonly providerEvents: ProviderEventEmitter
		readonly providerState: ProviderState
		readonly compatibility: MetaMaskCompatibility
		readonly selection: SignerSelection
		readonly signerConnection: SignerConnection
		readonly signerAccounts: SignerAccounts
		readonly signerRequests: SignerRequests
		readonly safeAppsBridge: ReturnType<typeof createSafeAppsBridge>
	}) {
		const applyAccountsChanged = (replyRequest: InterceptedRequestForwardWithResult) => {
			const accounts = replyRequest.result
			if (!Array.isArray(accounts) || !isStringArray(accounts)) throw new Error('wrong type')
			const replyAddress = accounts[0] ?? ''
			const replayedForSettledRequest = replyRequest.requestId !== undefined
			const notifyAccountsChanged = () => {
				if (providerState.currentAddress === replyAddress && !replayedForSettledRequest) return
				providerState.currentAddress = replyAddress
				compatibility.refreshAccountCompatibilityProperties(accounts)
				providerEvents.emitAccountsChanged(accounts)
			}
			if (replyRequest.requestId !== undefined) {
				bridge.queueRequestScopedProviderEvent(replyRequest.requestId, notifyAccountsChanged)
				return
			}
			notifyAccountsChanged()
		}

		const applyConnect = (replyRequest: InterceptedRequestForwardWithResult) => {
			const notifyConnect = () => {
				providerState.connected = true
				providerEvents.emitConnect(replyRequest.result)
			}
			if (replyRequest.requestId !== undefined) {
				bridge.queueRequestScopedProviderEvent(replyRequest.requestId, notifyConnect)
				return
			}
			if (providerState.connected) return
			notifyConnect()
		}

		const applyDisconnect = (replyRequest: InterceptedRequestForwardWithResult) => {
			if (replyRequest.requestId !== undefined) return
			if (!providerState.connected) return
			providerState.connected = false
			providerEvents.emitDisconnect()
		}

		const applyChainChanged = (replyRequest: InterceptedRequestForwardWithResult) => {
			if (replyRequest.requestId !== undefined) return
			const chainId = replyRequest.result
			if (typeof chainId !== 'string') throw new Error('wrong type')
			if (providerState.activeChainId === chainId) return
			providerState.activeChainId = chainId
			if (compatibility.isEnabled() && !selection.hasSigner() && inpageWindow.ethereum !== undefined) {
				compatibility.setChainCompatibilityProperties(inpageWindow.ethereum, chainId)
			}
			providerEvents.emitChainChanged(chainId)
		}

		// Without a signer, compatibility mode mirrors account and chain replies into the synchronous legacy properties.
		const applyCompatibilityReply = (replyRequest: InterceptedRequestForwardWithResult) => {
			if (!compatibility.isEnabled() || selection.hasSigner() || inpageWindow.ethereum === undefined) return
			switch (replyRequest.method) {
				case 'eth_requestAccounts':
				case 'eth_accounts': {
					const accounts = replyRequest.result
					if (!Array.isArray(accounts) || !isStringArray(accounts)) throw new Error('wrong type')
					providerState.currentAddress = accounts[0] ?? ''
					compatibility.refreshAccountCompatibilityProperties(accounts)
					return
				}
				case 'eth_chainId': {
					const chainId = replyRequest.result
					if (typeof chainId !== 'string') throw new Error('wrong type')
					compatibility.setChainCompatibilityProperties(inpageWindow.ethereum, chainId)
					providerState.activeChainId = chainId
					return
				}
				default: return
			}
		}

		const applyReply = async (replyRequest: InterceptedRequestForwardWithResult) => {
			if (replyRequest.subscription !== undefined) {
				providerEvents.emitSubscriptionMessage(replyRequest.result)
				return
			}
			// inform callbacks
			switch (replyRequest.method) {
				case 'accountsChanged': return applyAccountsChanged(replyRequest)
				case 'connect': return applyConnect(replyRequest)
				case 'disconnect': return applyDisconnect(replyRequest)
				case 'chainChanged': return applyChainChanged(replyRequest)
				case 'safe_apps_compatibility': {
					const safeAppsCompatibility = parseSafeAppsCompatibility(replyRequest.result)
					if (safeAppsCompatibility !== undefined) safeAppsBridge.setEnabled(safeAppsCompatibility.enabled, safeAppsCompatibility.canRequestAccess)
					return
				}
				case 'request_signer_to_eth_requestAccounts': return await signerAccounts.requestAccountsFromSigner()
				case 'request_signer_to_eth_accounts': return await signerAccounts.getAccountsFromSigner()
				case 'request_signer_to_wallet_switchEthereumChain': {
					if (typeof replyRequest.result !== 'string' || typeof replyRequest.walletSwitchRequestId !== 'string') throw new Error('Invalid wallet switch command')
					return await signerRequests.requestChangeChainFromSigner(replyRequest.result, replyRequest.walletSwitchRequestId)
				}
				case 'request_signer_to_wallet_watchAsset': return await signerRequests.requestWatchAssetFromSigner(replyRequest.result)
				case 'request_signer_connection_status': return await signerConnection.connectToSigner(selection.getSignerName())
				case 'request_signer_chainId': return await signerConnection.requestChainIdFromSigner()
				default: return
			}
		}

		const settleRequestWithReply = (replyRequest: InterceptedRequestForwardWithResult) => {
			if (replyRequest.requestId === undefined) return
			if (isRequestScopedProviderEventMethod(replyRequest.method)) return
			const pending = bridge.getOutstandingRequest(replyRequest.requestId)
			if (pending === undefined) return
			if (shouldResolveAfterRequestScopedProviderEvents(pending.method, replyRequest.method)) {
				bridge.resolveWithRequestScopedProviderEvents(replyRequest.requestId, replyRequest.result)
				return
			}
			pending.reply.resolve(replyRequest.result)
		}

		// The reply settles its request even when applying it fails; the failure itself still reaches the caller's error handling.
		const handleReplyRequest = async (replyRequest: InterceptedRequestForwardWithResult) => {
			try {
				await applyReply(replyRequest)
			} finally {
				settleRequestWithReply(replyRequest)
			}
		}

		const handleForwardToSigner = async (forwardRequest: InterceptedRequestForwardToSigner) => {
			if (forwardRequest.requestId === undefined) throw new Error('requestId missing')
			const pendingRequest = bridge.getOutstandingRequest(forwardRequest.requestId)
			if (pendingRequest === undefined) throw new Error('Request did not exist anymore')
			if (!selection.hasSigner()) throw new Error('Interceptor is in wallet mode and should not forward to an external wallet')
			const signerReply = await signerRequests.requestForwardedSignerReply(forwardRequest)
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
					pendingRequest.reply.reject(parseRpcError(signerReply.error))
					return
				}
				await signerRequests.sendForwardedSignerReply(signerReply, pendingRequest)
			} catch (error: unknown) {
				pendingRequest.reply.reject(error instanceof Error ? error : parseRpcError(error))
			}
		}

		const onBackgroundMessage = async (messageEvent: unknown) => {
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
				if (forwardRequest.type === 'result' && forwardRequest.requestId !== undefined && bridge.getOutstandingRequest(forwardRequest.requestId) === undefined) return
				if (forwardRequest.type === 'result' && 'error' in forwardRequest) {
					if (forwardRequest.requestId === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
					const pending = bridge.getOutstandingRequest(forwardRequest.requestId)
					if (pending === undefined) throw new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data)
					return pending.reply.reject(new EthereumJsonRpcError(forwardRequest.error.code, forwardRequest.error.message, forwardRequest.error.data))
				}
				if (forwardRequest.type === 'result' && 'result' in forwardRequest) {
					applyCompatibilityReply(forwardRequest)
					await handleReplyRequest(forwardRequest)
					return
				}
				if (forwardRequest.type !== 'forwardToSigner') throw new Error('type: forwardToSigner missing')
				await handleForwardToSigner(forwardRequest)
			} catch (error: unknown) {
				console.error(messageEvent)
				console.error(error)
				bridge.reportInterceptorError(serializeForwardedDiagnostics('inpage', 'handle background reply', error, getForwardedDiagnosticsRequestContext(messageEvent.data)))
				const requestId = 'requestId' in messageEvent.data && typeof messageEvent.data.requestId === 'number' ? messageEvent.data.requestId : undefined
				if (requestId === undefined) return
				const pendingRequest = bridge.getOutstandingRequest(requestId)
				if (pendingRequest === undefined) return
				pendingRequest.reply.reject(error instanceof Error ? error : parseRpcError(error))
			}
		}

		return onBackgroundMessage
	}

	// Provider injection: installs the Interceptor provider as window.ethereum around any wallet that is already present and announces it through EIP-6963.
	function createProviderInjection({ providerMethods, selection, signerConnection, compatibility, providerState }: {
		readonly providerMethods: InterceptorProviderMethods
		readonly selection: SignerSelection
		readonly signerConnection: SignerConnection
		readonly compatibility: MetaMaskCompatibility
		readonly providerState: ProviderState
	}) {
		const { reportSignerDiscoveryError } = signerConnection

		const injectEthereumIntoWindow = () => {
			if (!('ethereum' in inpageWindow) || !inpageWindow.ethereum) {
				// no existing signer found
				inpageWindow.ethereum = providerMethods.createInterceptorProvider(undefined)
				providerState.connected = true
				signerConnection.connectToSigner('NoSigner')
				return
			}
			const injectedWindowEthereum = inpageWindow.ethereum
			const fallBackToNoSigner = () => {
				inpageWindow.ethereum = providerMethods.createInterceptorProvider(undefined)
				providerState.connected = true
				selection.setSignerProvider(undefined, undefined)
				signerConnection.connectToSigner('NoSigner')
			}
			let rootIsInterceptor = false
			try { rootIsInterceptor = injectedWindowEthereum.isInterceptor === true } catch (error: unknown) { reportSignerDiscoveryError('read root Interceptor marker', error) }
			if (rootIsInterceptor) return
			const preparedMetaMaskProvider = signerConnection.findPreparedLegacyMetaMaskProvider(injectedWindowEthereum)

			let rootIsAmbire = false
			let rootIsBraveWallet = false
			let rootIsCoinbaseWallet = false
			let rootIsMetaMask = false
			let rootIsRabby = false
			let rootProviderMap: Map<string, WindowEthereum> | undefined
			try { rootIsAmbire = injectedWindowEthereum.isAmbire === true } catch (error: unknown) { reportSignerDiscoveryError('read root Ambire marker', error) }
			try { rootIsBraveWallet = injectedWindowEthereum.isBraveWallet === true } catch (error: unknown) { reportSignerDiscoveryError('read root Brave marker', error) }
			try { rootIsCoinbaseWallet = injectedWindowEthereum.isCoinbaseWallet === true } catch (error: unknown) { reportSignerDiscoveryError('read root Coinbase marker', error) }
			try { rootIsMetaMask = injectedWindowEthereum.isMetaMask === true } catch (error: unknown) { reportSignerDiscoveryError('read root MetaMask marker', error) }
			try { rootIsRabby = injectedWindowEthereum.isRabby === true } catch (error: unknown) { reportSignerDiscoveryError('read root Rabby marker', error) }
			try { rootProviderMap = injectedWindowEthereum.providerMap } catch (error: unknown) { reportSignerDiscoveryError('read root provider map', error) }
			const rootSignerName = getSignerNameFromWalletMarkers({
				isAmbire: rootIsAmbire,
				isBrave: rootIsBraveWallet,
				isCoinbase: rootIsCoinbaseWallet,
				isMetaMask: rootIsMetaMask,
				isRabby: rootIsRabby,
			})

			if (preparedMetaMaskProvider === undefined && (rootIsBraveWallet || rootProviderMap !== undefined || rootIsCoinbaseWallet)) {
				let mapSignerWindowEthereum: WindowEthereum | undefined
				try { mapSignerWindowEthereum = rootProviderMap?.get('CoinbaseWallet') } catch (error: unknown) { reportSignerDiscoveryError('read mapped Coinbase signer', error) }
				const preparedMapSigner = signerConnection.prepareSignerProvider(mapSignerWindowEthereum, 'CoinbaseWallet', false, false)
				const preparedRootSigner = preparedMapSigner === undefined ? signerConnection.prepareSignerProvider(injectedWindowEthereum, rootSignerName, false, false) : undefined
				const preparedSigner = preparedMapSigner ?? preparedRootSigner
				if (preparedSigner === undefined) {
					fallBackToNoSigner()
					return
				}
				const signerName = preparedMapSigner === undefined ? rootSignerName : 'CoinbaseWallet'
				let fallbackRequest: EthereumRequest | undefined
				if (preparedMapSigner !== undefined) {
					try { fallbackRequest = injectedWindowEthereum.request.bind(injectedWindowEthereum) } catch (error: unknown) { reportSignerDiscoveryError('bind root fallback signer request', error) }
				}
				providerState.connected = preparedSigner.connected
				selection.setSignerProvider(preparedSigner.provider, preparedSigner.request, fallbackRequest)
				inpageWindow.ethereum = providerMethods.createInterceptorProvider(preparedSigner.provider)
				compatibility.installControlledAccountCompatibilityProperties()
				signerConnection.connectToSigner(signerName)
				return
			}
			const preparedRootSigner = preparedMetaMaskProvider ?? signerConnection.prepareSignerProvider(injectedWindowEthereum, rootSignerName, false, false)
			if (preparedRootSigner === undefined) {
				fallBackToNoSigner()
				return
			}
			const fallbackSignerWindowEthereum = preparedRootSigner.provider
			const fallbackSignerName = preparedMetaMaskProvider === undefined ? rootSignerName : 'MetaMask'
			selection.setSignerProvider(fallbackSignerWindowEthereum, preparedRootSigner.request)
			providerState.connected = preparedRootSigner.connected
			// we cannot inject window.ethereum alone here as it seems like window.ethereum is cached (maybe ethers.js does that?)
			if (fallbackSignerWindowEthereum !== injectedWindowEthereum || compatibility.hasNonConfigurableAccountCompatibilityProperty()) {
				compatibility.installControlledAccountCompatibilityProperties()
				inpageWindow.ethereum = providerMethods.createInterceptorProvider(fallbackSignerWindowEthereum)
			} else {
				Object.assign(fallbackSignerWindowEthereum, providerMethods.createInterceptorProvider(fallbackSignerWindowEthereum))
			}
			compatibility.installControlledAccountCompatibilityProperties()
			signerConnection.connectToSigner(fallbackSignerName)
		}

		const announceProvider = () => {
			const info: EIP6963ProviderInfo = {
				uuid: '200ecd95-afe4-4684-bce7-0f2f8bdd3498',
				name: 'The Interceptor',
				icon: INTERCEPTOR_PROVIDER_ICON,
				rdns: 'dark.florist'
			}

			if (inpageWindow.ethereum === undefined || !inpageWindow.ethereum.isInterceptor) injectEthereumIntoWindow()
			const provider = inpageWindow.ethereum
			if (provider === undefined) throw new Error('The Interceptor provider was not initialized')
			window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
		}

		return {
			injectEthereumIntoWindow,
			announceProviderOnPageLoad: () => {
				window.addEventListener('eip6963:requestProvider', () => { announceProvider() } )
				announceProvider()
				signerConnection.discoverAnnouncedMetaMaskProvider()
			},
			handleEthereumInitialized: () => {
				injectEthereumIntoWindow()
				if (selection.getSignerName() === 'NoSigner' || selection.getSignerName() === 'Brave') signerConnection.discoverAnnouncedMetaMaskProvider()
			},
			// coinbase wallet sends different kind of message on inject, this function identifies that and reinjects
			onWindowMessage: (messageEvent: unknown) => {
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
				if (messageEvent.data.type === 'extensionUIRequest' && messageEvent.data.data.action === 'loadWalletLinkProvider') injectEthereumIntoWindow()
			},
		}
	}

	function injectInterceptor() {
		const providerState: ProviderState = { connected: false, currentAddress: '', activeChainId: '' }
		const signerAccountsRequestState: SignerAccountsRequestState = { pendingRequestAccountsResolution: undefined }
		const selection = createSignerSelection()
		const bridge = createBackgroundBridge(() => !selection.hasSigner())
		const providerEvents = createProviderEventEmitter()
		const compatibility = createMetaMaskCompatibility(providerState)
		const signerConnection = createSignerConnection({ bridge, compatibility, selection, providerState, signerAccountsRequestState })
		const signerAccounts = createSignerAccounts({ bridge, selection, signerConnection, signerAccountsRequestState })
		const signerRequests = createSignerRequests(bridge, selection)
		const providerMethods = createInterceptorProviderMethods({ bridge, providerEvents, compatibility, providerState })
		// The page owns SDK settings; every signing request carries its mode across background port recreation.
		const safeAppsBridge = createSafeAppsBridge(inpageWindow, createSafeAppsRequestHandler(
			async (request) => await bridge.requestInternal({ method: 'safe_apps_request', params: [request] }),
			async (request) => await providerMethods.request(request),
		), async () => {
			// Restore persisted access after reload before considering an interactive wallet connection.
			const accounts = await providerMethods.request({ method: 'eth_accounts' })
			if (!Array.isArray(accounts) || accounts.length === 0) await providerMethods.request({ method: 'eth_requestAccounts' })
			// Recheck Safe eligibility after the ordinary wallet/site approval flow completes.
			await bridge.requestInternal({ method: 'safe_apps_request', params: [{ method: 'getEnvironmentInfo' }] })
		})
		const providerInjection = createProviderInjection({ providerMethods, selection, signerConnection, compatibility, providerState })

		// Startup order is page-visible: the Safe Apps listener above, then the bridge port, window.ethereum injection, the EIP-6963 announcement, and finally the window listeners.
		bridge.connect(createBackgroundMessageHandler({ bridge, providerEvents, providerState, compatibility, selection, signerConnection, signerAccounts, signerRequests, safeAppsBridge }))
		providerInjection.injectEthereumIntoWindow()
		providerInjection.announceProviderOnPageLoad()
		window.addEventListener('message', providerInjection.onWindowMessage)

		// keep listening for other wallets that announce themselves and reinject without patching dispatchEvent
		window.addEventListener('ethereum#initialized', providerInjection.handleEthereumInitialized)
		window.dispatchEvent(new Event('ethereum#initialized'))
	}

	injectInterceptor()
})()
