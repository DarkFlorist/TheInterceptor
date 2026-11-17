import type { Settings } from '../types/interceptor-messages.js'
import { type AdmittedRpcNetworkNoLongerLive, type CapturedRpcNetwork, getLiveSettingsOnAdmittedRpcNetwork, type ReadyRpcSettings } from './settings.js'

// The connection-grant contract: the only way to obtain settings that may grant a connection, and the check that they are used only inside the grant they were read for. verifyAccess and connectToPort take LiveSettings, so granting policy depends on this module, while settings.ts only reads settings and checks them against the admitted network (getLiveSettingsOnAdmittedRpcNetwork, which request routing uses as well).

const liveSettingsMarker = Symbol('liveSettings')
// Settings proven to come from a ready RPC configuration on the network the caller worked on, read just now. Granting a connection takes this type (see verifyAccess and connectToPort), so code that holds plain settings cannot grant. Only grantWithLiveSettings creates it, for the synchronous grant it runs right after the read, and the grant functions reject it outside that call (assertLiveSettingsInGrantWindow).
export type LiveSettings = ReadyRpcSettings & { readonly [liveSettingsMarker]: true }

// Checked at runtime because the type system cannot see live settings captured by a closure that runs after the grant; asynchronous grants are rejected by type (Synchronous). The live settings whose grant is running right now. A grant runs synchronously, so a value is here only between the read and the end of its grant; a value the grant let escape (returned, or captured by a closure that runs later) is no longer here once anything could have awaited.
const liveSettingsInGrantWindow = new WeakSet<LiveSettings>()

// Called by every function that grants with LiveSettings: using live settings after their grant returned fails loudly instead of granting on settings that may have changed meanwhile.
export function assertLiveSettingsInGrantWindow(settings: LiveSettings) {
	if (!liveSettingsInGrantWindow.has(settings)) throw new Error('Live settings were used outside the grant they were read for. Grant inside grantWithLiveSettings.')
}

// A result that is not a promise: a grant that returns one would continue after an await, when the live settings may no longer hold.
type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result

// The only way to grant: reads the live settings and, while they are still on the admitted network, runs `grant` with them at once. Two checks keep an await from coming between the read and the grant: `grant` must be synchronous (one that returns a promise does not type-check), and the settings are valid for granting only while it runs (assertLiveSettingsInGrantWindow), so settings that escape the grant fail when used. A grant whose follow-up work is asynchronous returns that work wrapped in an object, so the grant itself still completes synchronously.
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
