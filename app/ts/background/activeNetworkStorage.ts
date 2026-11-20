import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { getActiveRpcNetwork, parseStoredActiveRpcNetwork } from '../utils/pageSafeSettings.js'
import { hasOwnKey } from '../utils/typescript.js'
import { writeLocalStorage } from '../utils/localStorageWrites.js'

// The one owner of the stored active network's freshness protocol: its writer, the counters that writer keeps, the storage.onChanged observer, and actOnStoredActiveNetwork, the bounded read through which every reader that must act on the network that is stored when it acts does so. Nothing outside this module reads the counters or compares them.

// Guarantee: when actOnStoredActiveNetwork runs act, no write of the active network through writeActiveNetwork was running when its read started or has started since, so the value act receives is the value stored at that step. This holds because every write of the key in app code goes through writeActiveNetwork, which counts it synchronously before its storage set starts, and the background runs in one JavaScript realm, so no counted write can start between the check and act. That every write goes through writeActiveNetwork is enforced structurally: the generic setter and remover in storageUtils.ts exclude the key at the type level, and the raw-storage scan in pageContextSettingsImports.test.ts rejects every other direct storage write, clear() included, in every app module, background, page and inpage alike, so no app code can write the key out of band. Why counters rather than a version stored with the network: storage offers no compare-and-set, and the check has to be synchronous with the act, so a stored version could not be checked at the act either. The counters live as long as the background does and every check starts and ends within one call, so none compares counts across a restart.

// What the guarantee does not cover: a write made outside the extension's code, such as a stored value edited by hand in the browser's developer tools. The onChanged observer below makes such a write whose notification arrives before the act refuse the read too, but storage reports changes asynchronously, so one whose notification arrives after the act is not seen; no app path can produce such a write.
let activeNetworkWritesStarted = 0
let activeNetworkWritesFinished = 0
let activeNetworkChangesObserved = 0

function observeActiveNetworkChanges(changes: Readonly<Record<string, unknown>>, areaName: string) {
	if (areaName === 'local' && hasOwnKey(changes, 'activeRpcNetwork')) activeNetworkChangesObserved += 1
}

// Starts counting every change of the stored active network that storage reports, whichever path wrote it, as defence in depth for a write outside the counted writer. The background calls it at startup; it returns the stop.
export function startObservingActiveNetworkChanges() {
	browser.storage.onChanged.addListener(observeActiveNetworkChanges)
	return () => browser.storage.onChanged.removeListener(observeActiveNetworkChanges)
}

// Writes the active network, together with any other items of the same update, and counts the write.
export async function writeActiveNetwork(items: LocalStorageItems & { readonly activeRpcNetwork: RpcNetwork }) {
	activeNetworkWritesStarted += 1
	try {
		await writeLocalStorage(serializeLocalStorageItems(items))
	} finally {
		activeNetworkWritesFinished += 1
	}
}

// Writes the items of one storage update, through writeActiveNetwork when the update includes the active network, so an update that composes several owners' writes, such as a settings import, counts a network write too. Both paths store through the tracked local-storage writer, so a simulation mode change in the update is seen by the signer-forward guard.
export async function writeLocalStorageItems(items: LocalStorageItems) {
	const { activeRpcNetwork } = items
	if (activeRpcNetwork === undefined) return await writeLocalStorage(serializeLocalStorageItems(items))
	return await writeActiveNetwork({ ...items, activeRpcNetwork })
}

// Called right before the active network is read. The returned check tells, synchronously, whether the network read is still the stored one: it is not if a write through writeActiveNetwork was running when the read started or has started since, or if storage has reported a change of the key since.
function beginActiveNetworkRead() {
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

// Reads only the active network, as getSettings does, together with a synchronous check of whether it is still current.
export async function readActiveNetworkSnapshot(): Promise<ActiveNetworkSnapshot> {
	const isStillCurrent = beginActiveNetworkRead()
	const activeRpcNetwork = await getActiveRpcNetwork()
	return { activeRpcNetwork, isStillCurrent }
}

// How many times actOnStoredActiveNetwork reads the network by default before it gives up. A network switch writes the network once, so a second read is current unless writes keep arriving.
export const ACTIVE_NETWORK_READ_LIMIT = 10

export type ActiveNetworkAct<T> = { readonly current: true, readonly result: T } | { readonly current: false, readonly lastReadActiveRpcNetwork: RpcNetwork }

// Reads the stored active network until a read is still the stored network, at most maxReads times, and runs act on that network in the same synchronous step as the passing check, so act acts on the network stored at that step; act may start asynchronous work, which then starts in that step too. If every read was overlapped by a write, act is not run and the last network read is returned for a caller that can use a possibly stale network, such as an advisory display.
export async function actOnStoredActiveNetwork<T>(act: (activeRpcNetwork: RpcNetwork) => T, maxReads = ACTIVE_NETWORK_READ_LIMIT): Promise<ActiveNetworkAct<T>> {
	if (!Number.isInteger(maxReads) || maxReads < 1) throw new Error('The active network is read at least once')
	for (let read = 1; ; read++) {
		const snapshot = await readActiveNetworkSnapshot()
		if (snapshot.isStillCurrent()) return { current: true, result: act(snapshot.activeRpcNetwork) }
		if (read >= maxReads) return { current: false, lastReadActiveRpcNetwork: snapshot.activeRpcNetwork }
	}
}
