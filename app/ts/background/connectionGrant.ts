import type { Settings } from '../types/interceptor-messages.js'
import { type AdmittedRpcNetworkNoLongerLive, type CapturedRpcNetwork, getLiveSettingsOnAdmittedRpcNetwork, type ReadyRpcSettings } from './settings.js'

// Reconciliation uses this live reread for its synchronous grant. Other entry points still accept ordinary Settings until the admission layer migrates their signatures.

const liveSettingsMarker = Symbol('liveSettings')
// Settings read from a ready configuration on the caller's admitted network. grantWithLiveSettings creates this marker for its callback; legacy granting APIs do not enforce it yet.
export type LiveSettings = ReadyRpcSettings & { readonly [liveSettingsMarker]: true }

// This optional runtime assertion detects a marked value used after its callback returned. Admission-layer callers can opt in when their APIs require LiveSettings.
const liveSettingsInGrantWindow = new WeakSet<LiveSettings>()

// Available to typed admission-layer callers; current reconciliation relies on the synchronous callback rather than invoking this assertion.
export function assertLiveSettingsInGrantWindow(settings: LiveSettings) {
	if (!liveSettingsInGrantWindow.has(settings)) throw new Error('Live settings were used outside the grant they were read for. Grant inside grantWithLiveSettings.')
}

// A result that is not a promise: a grant that returns one would continue after an await, when the live settings may no longer hold.
type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result

// Re-read on the admitted network, then invoke the callback synchronously. Asynchronous follow-up work is returned inside an object so it cannot defer the grant itself; the optional runtime marker check is not enforced by legacy entry points.
export async function grantWithLiveSettings<Grant extends (settings: LiveSettings) => unknown>(
	admitted: Settings | CapturedRpcNetwork,
	grant: Grant & ((settings: LiveSettings) => Synchronous<ReturnType<Grant>>),
): Promise<{ readonly kind: 'granted', readonly result: Synchronous<ReturnType<Grant>> } | { readonly kind: AdmittedRpcNetworkNoLongerLive }> {
	const live = await getLiveSettingsOnAdmittedRpcNetwork(admitted)
	if (live.kind !== 'ready') return live
	const liveSettings: LiveSettings = { ...live.settings, [liveSettingsMarker]: true }
	const runGrant: (settings: LiveSettings) => Synchronous<ReturnType<Grant>> = grant
	liveSettingsInGrantWindow.add(liveSettings)
	try {
		return { kind: 'granted', result: runGrant(liveSettings) }
	} finally {
		liveSettingsInGrantWindow.delete(liveSettings)
	}
}
