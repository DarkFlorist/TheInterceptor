import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../utils/constants.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import { getUpdatedSimulationStackSnapshot } from './simulationUpdating.js'
import { identifyAddress } from './metadataUtils.js'
import * as funtypes from 'funtypes'
import { EthereumJsonRpcRequest } from '../types/JsonRpc-types.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import type { ResolvedSimulationState } from '../types/visualizer-types.js'
import type { InterceptedRequest } from '../utils/requests.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { InterceptedRequestForward, Settings } from '../types/interceptor-messages.js'
import { resolveSiteBehavior } from '../utils/siteBehaviors.js'
import { getConnectionOrigin } from './siteBehaviorContext.js'
import { getSiteRpcInterceptionEnabled } from './settings.js'
import { isGnosisSafeAppsConnectionEligibleForAdmittedAddress } from './gnosisSafeAppsConnectionEligibility.js'
import type { AddressedRequestAccessContext } from './requestAccessContext.js'

const simulationNativeToken = ETHEREUM_LOGS_LOGGER_ADDRESS

const SiteRpcEnvelope = funtypes.ReadonlyObject({ chainId: EthereumQuantity, request: funtypes.Union(EthereumJsonRpcRequest, funtypes.ReadonlyObject({ method: funtypes.Literal('interceptor_getSimulationTokens') }), funtypes.ReadonlyObject({ method: funtypes.Literal('interceptor_getSimulationTokenMetadata') })) })
const rejected = (message: string) => ({ kind: 'rejected' as const, message })

export type SiteRpcExecution =
	| { readonly kind: 'tokens', readonly request: InterceptedRequest, readonly includeTokenMetadata: boolean }
	| { readonly kind: 'rpc', readonly request: InterceptedRequest }
	| { readonly kind: 'rejected', readonly message: string }

// Published contexts select behavior; they never authorize a request. Resolve the same universal policy and overrides against the browser-owned origin and current mode/chain on every read.
export function getSiteRpcExecution(request: InterceptedRequest, origin: string | undefined, simulationMode: boolean, chainId: bigint): SiteRpcExecution | undefined {
	if (request.method !== 'site_rpc_request') return undefined
	const behavior = origin === undefined ? undefined : resolveSiteBehavior(origin)
	if (behavior === undefined || !simulationMode) return rejected('Site RPC interception requires an approved HTTP(S) simulation session.')
	const parsed = SiteRpcEnvelope.safeParse('params' in request ? request.params?.[0] : undefined)
	if (!parsed.success) return rejected('Invalid site read-only RPC request.')
	if (parsed.value.chainId !== chainId) return rejected('The site RPC chain changed before the simulated read.')
	if (parsed.value.request.method === 'interceptor_getSimulationTokens' || parsed.value.request.method === 'interceptor_getSimulationTokenMetadata') return { kind: 'tokens', request, includeTokenMetadata: parsed.value.request.method === 'interceptor_getSimulationTokenMetadata' }
	if (!behavior.rpcReads.methods.some((method) => method === parsed.value.request.method)) return rejected('Invalid site read-only RPC request.')
	const rpc = serialize(EthereumJsonRpcRequest, parsed.value.request)
	const params = 'params' in rpc ? rpc.params ?? [] : []
	return { kind: 'rpc', request: { ...request, method: rpc.method, params: [...params] } }
}

// A balance API's live response omits tokens received only in the simulation. Expose only fungible-token addresses observed for this selected account and chain, never the transaction stack or another account's balances.
export function getSiteSimulationTokens(state: ResolvedSimulationState, address: bigint, chainId: bigint) {
	if (state.kind !== 'simulated' || state.value.rpcNetwork.chainId !== chainId || !state.value.success) return []
	return [...new Set(state.value.simulatedBlocks.flatMap((block) => block.simulatedTransactions.flatMap((transaction) =>
		transaction.tokenBalancesAfter.filter((balance) => balance.owner === address && balance.tokenId === undefined && balance.token !== simulationNativeToken).map((balance) => balance.token)
	)))]
}

type SiteRpcAdmission = { readonly kind: 'execute', readonly context: RpcRequestContext } | { readonly kind: 'reply', readonly reply: InterceptedRequestForward }

// Site admission owns pseudo-method snapshot reads and replies; ordinary RPC execution rejoins the same shared pipeline as other admitted protocols.
export async function prepareSiteRpcRequest(ethereum: EthereumClientService, connections: WebsiteTabConnections, request: InterceptedRequest, settings: Settings, accessContext: AddressedRequestAccessContext): Promise<SiteRpcAdmission> {
	const failure = (message: string): SiteRpcAdmission => ({ kind: 'reply', reply: { type: 'result', method: 'site_rpc_request', uniqueRequestIdentifier: request.uniqueRequestIdentifier, error: { code: -32602, message } } })
	const { activeAddress } = accessContext
	const socket = request.uniqueRequestIdentifier.requestSocket
	// The router's effective socket is the approved top-level source for native children; both protocols validate the same admitted account and chain.
	const eligible = isGnosisSafeAppsConnectionEligibleForAdmittedAddress(connections, accessContext.accessSocket, settings, { activeAddress, safeSigningMode: false })
	if (!await getSiteRpcInterceptionEnabled() || !settings.simulationMode || !eligible) return failure('Site RPC interception is not enabled for this connection.')
	const execution = getSiteRpcExecution(request, getConnectionOrigin(connections, socket), settings.simulationMode, settings.activeRpcNetwork.chainId)
	if (execution === undefined) return failure('Unsupported site RPC request.')
	if (execution.kind === 'rejected') return failure(execution.message)
	if (execution.kind === 'rpc') return { kind: 'execute', context: { request: execution.request } }
	const snapshot = await getUpdatedSimulationStackSnapshot(ethereum, true)
	const result = execution.includeTokenMetadata
		? await getSiteSimulationTokenMetadata(snapshot.simulationState, activeAddress.address, settings.activeRpcNetwork.chainId, async (address) => await identifyAddress(ethereum, undefined, address, false))
		: getSiteSimulationTokens(snapshot.simulationState, activeAddress.address, settings.activeRpcNetwork.chainId)
	return { kind: 'reply', reply: { type: 'result', method: 'site_rpc_request', result, uniqueRequestIdentifier: request.uniqueRequestIdentifier } }
}

// Only simulation-observed token addresses and the native currency may be named for a website. Callers use public metadata, without user address-book labels.
export async function getSiteSimulationTokenMetadata(state: ResolvedSimulationState, address: bigint, chainId: bigint, identify: (address: bigint) => Promise<AddressBookEntry>) {
	const entries = await Promise.all([simulationNativeToken, ...getSiteSimulationTokens(state, address, chainId)].map(identify))
	return entries.flatMap((entry) => entry.type === 'ERC20' ? [{ address: entry.address, name: entry.name, symbol: entry.symbol, decimals: entry.decimals }] : [])
}
