import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { getActiveRpcNetwork, parseStoredActiveRpcNetwork } from '../utils/pageSafeSettings.js'
import { hasOwnKey } from '../utils/typescript.js'

// The background's writer of the stored active network, and the reads that must know whether a network they read is still the stored one. A transaction approval commits only against a network that is still stored, which readActiveNetworkSnapshot's isStillCurrent tells in the same synchronous step as the commit. How freshness holds whoever writes the network: storage orders every read and write, from any path or context, so a write is either seen by the guard's read or lands after it, and a commit made on that read comes before the write, as if the network was switched right after approving. Two counters then also invalidate a read that a write overlapped: the writes started through writeActiveNetwork, counted when they are issued, and the changes of the key that storage reports through observeActiveNetworkChanges, from any path, including one that bypasses writeActiveNetwork or reaches the storage API without naming browser. A read overlapped by either is read again, which fails closed: proceedOnRequestedNetwork never commits on a read it cannot vouch for. The type-level exclusion of the key from the generic storage setters and the raw-storage scan in pageContextSettingsImports.test.ts keep writes going through writeActiveNetwork, which reports a switch at once rather than when storage reports it, but freshness no longer depends on them. Pages read the network through pageSafeSettings.ts and never reach this module. Why counters rather than a version stored with the network: storage offers no compare-and-set, and the check has to be synchronous with the commit, so a stored version could only be compared on a read ordered exactly like the network read itself, while it would change the stored settings format, its import and export, and every stored value; it would detect no write that these counters miss. The counters live as long as the background does, and every check starts and ends within one proceedOnRequestedNetwork call, so none compares counts across a restart.
let activeNetworkWritesStarted = 0
let activeNetworkWritesFinished = 0
let activeNetworkChangesObserved = 0

// Counts every change of the stored active network that storage reports, whichever path wrote it. The background registers it as a storage.onChanged listener at startup.
export function observeActiveNetworkChanges(changes: Readonly<Record<string, unknown>>, areaName: string) {
	if (areaName === 'local' && hasOwnKey(changes, 'activeRpcNetwork')) activeNetworkChangesObserved += 1
}

// Writes the active network, together with any other items of the same update, and counts the write.
export async function writeActiveNetwork(items: LocalStorageItems & { readonly activeRpcNetwork: RpcNetwork }) {
	activeNetworkWritesStarted += 1
	try {
		await browser.storage.local.set(serializeLocalStorageItems(items))
	} finally {
		activeNetworkWritesFinished += 1
	}
}

// Called right before the active network is read. The returned check tells, synchronously, whether the network read is still the stored one: it is not if a write through writeActiveNetwork was running when the read started or has started since, or if storage reported a change of the key from any path since.
export function beginActiveNetworkRead() {
	const writesStartedBeforeRead = activeNetworkWritesStarted
	const changesObservedBeforeRead = activeNetworkChangesObserved
	const writeRunningWhenReadStarted = activeNetworkWritesStarted !== activeNetworkWritesFinished
	return () => !writeRunningWhenReadStarted && activeNetworkWritesStarted === writesStartedBeforeRead && activeNetworkChangesObserved === changesObservedBeforeRead
}

// Repairs a corrupt stored active network to the default network, once at background startup, so that no read of the network writes. Only a value written outside the background, by an older version or by hand, can be corrupt, since the background writes the network only through writeActiveNetwork with a parsed RpcNetwork; until the repair, getActiveRpcNetworkFromItems reads such a value as the default network, which the repair then stores.
export async function repairCorruptActiveNetwork() {
	const defaultRpcNetwork = DEFAULT_RPCS[0]
	if (defaultRpcNetwork === undefined) throw new Error('default rpc was missing')
	const isReadStillCurrent = beginActiveNetworkRead()
	const storedItems = await browser.storage.local.get(['activeRpcNetwork'])
	const { activeRpcNetwork: rawValue } = storedItems
	if (rawValue === undefined || parseStoredActiveRpcNetwork(storedItems) !== undefined) return
	console.warn('activeRpcNetwork was corrupt:')
	console.warn(rawValue)
	// A deliberate write of the active network, such as a network switch, may have started since the corrupt value was read; repairing then would replace the newer network with the default. So the repair is a compare-and-set on the write count: it writes only while the read is still current. The check and writeActiveNetwork's count of the new write run in one synchronous step, so no other write can start between them.
	if (isReadStillCurrent()) await writeActiveNetwork({ activeRpcNetwork: defaultRpcNetwork })
}

export type ActiveNetworkSnapshot = {
	readonly activeRpcNetwork: RpcNetwork
	// Whether the network read is still the stored active network. It is not once a write of the active network was running when the read started, or has started since.
	readonly isStillCurrent: () => boolean
}

// Reads only the active network, as getSettings does, together with a synchronous check of whether it is still current, for a reader that must act on the network that is stored when it acts.
export async function readActiveNetworkSnapshot(): Promise<ActiveNetworkSnapshot> {
	const isStillCurrent = beginActiveNetworkRead()
	const activeRpcNetwork = await getActiveRpcNetwork()
	return { activeRpcNetwork, isStillCurrent }
}
