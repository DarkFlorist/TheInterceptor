import { createInterceptorInternalError, getInterceptorInternalErrorCode } from '../utils/caughtErrors.js'
import { ERROR_ACTIVE_RPC_ENDPOINT_CHANGED, ERROR_ACTIVE_RPC_NETWORK_CHANGED } from '../utils/constants.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import type { Settings } from '../types/interceptor-messages.js'
import { getSettingsSnapshot } from './settings.js'
import { type ReadyRpcSettings, settingsIfRpcConfigurationReady } from './websiteAccessPolicy.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'

// A result that is not a promise: a grant that returns one would continue after an await, when the live settings may no longer hold.
type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result

// Re-read on the admitted network, then invoke the callback synchronously. Asynchronous follow-up work is returned inside an object so it cannot defer the grant itself.
export async function grantWithLiveSettings<Grant extends (settings: ReadyRpcSettings) => unknown>(
	admitted: Pick<Settings, 'activeRpcNetwork'>,
	grant: Grant & ((settings: ReadyRpcSettings) => Synchronous<ReturnType<Grant>>),
): Promise<{ readonly kind: 'granted', readonly result: Synchronous<ReturnType<Grant>> } | { readonly kind: AdmittedRpcNetworkNoLongerLive }> {
	const live = await getLiveSettingsOnAdmittedRpcNetwork(admitted)
	if (live.kind !== 'ready') return live
	const runGrant: (settings: ReadyRpcSettings) => Synchronous<ReturnType<Grant>> = grant
	return { kind: 'granted', result: runGrant(live.settings) }
}

export type AdmittedRpcNetworkNoLongerLive = 'unavailable' | 'chain-changed' | 'endpoint-changed'

function getNetworkChangeReply(kind: string | undefined) {
	switch (kind) {
		case 'chain-changed': return ERROR_ACTIVE_RPC_NETWORK_CHANGED
		case 'endpoint-changed': return ERROR_ACTIVE_RPC_ENDPOINT_CHANGED
		default: return undefined
	}
}

export function createConnectionGrantRefusal(kind: AdmittedRpcNetworkNoLongerLive): Error {
	const reply = getNetworkChangeReply(kind)
	return reply === undefined
		? createRpcConfigurationUnavailableError()
		: createInterceptorInternalError(reply.error.message, kind, 'handled')
}

export function getConnectionGrantRefusalReply(error: unknown) {
	return getNetworkChangeReply(getInterceptorInternalErrorCode(error))
}

type LiveSettingsOnAdmittedRpcNetwork =
	| { readonly kind: 'ready', readonly settings: ReadyRpcSettings }
	| { readonly kind: AdmittedRpcNetworkNoLongerLive }

// Connection grants re-read one live snapshot immediately before approval. Metadata-only changes retain the admitted endpoint; chain or endpoint changes invalidate its service pair.
async function getLiveSettingsOnAdmittedRpcNetwork(admitted: Pick<Settings, 'activeRpcNetwork'>): Promise<LiveSettingsOnAdmittedRpcNetwork> {
	const liveSettings = settingsIfRpcConfigurationReady(await getSettingsSnapshot())
	if (liveSettings === undefined) return { kind: 'unavailable' }
	const rpcNetworkChange = getRpcNetworkChange(admitted.activeRpcNetwork, liveSettings.activeRpcNetwork)
	if (rpcNetworkChange.chainChanged) return { kind: 'chain-changed' }
	// Rejected rather than continued: the admitted service pair still talks to the deselected endpoint (which the user may have left for privacy or reliability), and a signer-only selection's fallback service may serve another chain.
	if (rpcNetworkChange.endpointChanged) return { kind: 'endpoint-changed' }
	return { kind: 'ready', settings: liveSettings }
}
