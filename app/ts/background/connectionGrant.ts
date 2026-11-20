import type { Settings } from '../types/interceptor-messages.js'
import { type AdmittedRpcNetworkNoLongerLive, type CapturedRpcNetwork, getLiveSettingsOnAdmittedRpcNetwork, type ReadyRpcSettings } from './settings.js'

// Reconciliation reads settings again immediately before its synchronous grant. Other grant entry points retain their ordinary Settings signatures until the admission layer migrates them.
export type LiveSettings = ReadyRpcSettings

// A result that is not a promise: a grant that returns one would continue after an await, when the live settings may no longer hold.
type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result

// Re-read on the admitted network, then invoke the callback synchronously. Asynchronous follow-up work is returned inside an object so it cannot defer the grant itself.
export async function grantWithLiveSettings<Grant extends (settings: LiveSettings) => unknown>(
	admitted: Settings | CapturedRpcNetwork,
	grant: Grant & ((settings: LiveSettings) => Synchronous<ReturnType<Grant>>),
): Promise<{ readonly kind: 'granted', readonly result: Synchronous<ReturnType<Grant>> } | { readonly kind: AdmittedRpcNetworkNoLongerLive }> {
	const live = await getLiveSettingsOnAdmittedRpcNetwork(admitted)
	if (live.kind !== 'ready') return live
	const runGrant: (settings: LiveSettings) => Synchronous<ReturnType<Grant>> = grant
	return { kind: 'granted', result: runGrant(live.settings) }
}
