import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { getActiveRpcNetwork, parseStoredActiveRpcNetwork } from '../utils/pageSafeSettings.js'

// The background's only path that writes the stored active network, and the reads that must know whether a network they read is still stored. A transaction approval commits only against a network that is still stored, which readActiveNetworkSnapshot checks by counting writes, so the count and the write live together here and cannot be separated. The generic storage setter and remover in storageUtils.ts exclude the key at the type level, so writeActiveNetwork is the only typed way to write it. Page contexts compile their own copy of every module they import, whose counts the background would never see, so pageContextSettingsImports.test.ts keeps every page bundle from reaching this module; pages read the network through pageSafeSettings.ts. A raw browser.storage write would bypass the types and the counts, so the same test parses the application sources and allows browser.storage only as direct local.get calls, onChanged listeners, and local.set or local.remove calls in listed modules that never name the active network, rejecting clear and any alias of browser, browser.storage or browser.storage.local, apart from browser passed to a listed callee that uses it only as an identity key; the check is syntactic, so it cannot see the storage API reached without naming browser or chrome, such as through globalThis['browser'], and the keys those listed modules compute are checked by review. Why in-memory counters rather than a write generation persisted next to activeRpcNetwork: the only writer that can race an approval is this background, and every one of its active-network writes runs through writeActiveNetwork below, which the type-level setter exclusion and the import and raw-storage tests named above enforce, so these counters see every write that could change the network under an approval. They live as long as the background does, and so does every check that relies on them: readActiveNetworkSnapshot's isStillCurrent is taken and evaluated within one proceedOnRequestedNetwork call in transactionNetwork.ts, so no check ever compares counts across a restart, which ends that call, and a confirmation run from before a restart carries the old lifetime id, so isConfirmationVisualisationCurrent never takes it for the run of the new lifetime. Because every freshness check starts and ends within one background lifetime, persisting a generation would add nothing these counters do not already provide.
let activeNetworkWritesStarted = 0
let activeNetworkWritesFinished = 0

// Writes the active network, together with any other items of the same update, and counts the write.
export async function writeActiveNetwork(items: LocalStorageItems & { readonly activeRpcNetwork: RpcNetwork }) {
	activeNetworkWritesStarted += 1
	try {
		await browser.storage.local.set(serializeLocalStorageItems(items))
	} finally {
		activeNetworkWritesFinished += 1
	}
}

// Called right before the active network is read. The returned check tells, synchronously, whether the network read is still the stored one: it is not if a write of the active network was running when the read started, or has started since.
export function beginActiveNetworkRead() {
	const writesStartedBeforeRead = activeNetworkWritesStarted
	const writeRunningWhenReadStarted = activeNetworkWritesStarted !== activeNetworkWritesFinished
	return () => !writeRunningWhenReadStarted && activeNetworkWritesStarted === writesStartedBeforeRead
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
