import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, browserStorageLocalSafeParse, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { hasOwnKey } from '../utils/typescript.js'

// The background's only path that writes the stored active network, and the reads that must know whether a network they read is still stored. A transaction approval commits only against a network that is still stored, which readActiveNetworkSnapshot checks by counting writes, so the count and the write live together here and cannot be separated. The generic storage setter and remover in storageUtils.ts exclude the key at the type level, so writeActiveNetwork is the only typed way to write it. Page contexts compile their own copy of every module they import, whose counts the background would never see, so pageContextSettingsImports.test.ts keeps every page bundle from reaching this module; pages read the network through pageSafeSettings.ts. A raw browser.storage write would bypass the types and the counts, so the same test parses the application sources and allows browser.storage only as direct local.get calls, onChanged listeners, and local.set or local.remove calls in listed modules that never name the active network, rejecting clear and any alias of browser, browser.storage or browser.storage.local, apart from browser passed to a listed callee that uses it only as an identity key; the check is syntactic, so it cannot see the storage API reached without naming browser or chrome, such as through globalThis['browser'], and the keys those listed modules compute are checked by review. Why in-memory counters rather than a write generation persisted next to activeRpcNetwork: the only writer that can race an approval is this background, and every one of its active-network writes runs through writeActiveNetwork below, which the type-level setter exclusion and the import and raw-storage tests named above enforce, so these counters see every write that could change the network under an approval. They live as long as the background does, and so does every check that relies on them: readActiveNetworkSnapshot's isStillCurrent is taken and evaluated within one proceedOnRequestedNetwork call in transactionNetwork.ts, so no check ever compares counts across a restart, which ends that call, and a confirmation run from before a restart carries the old lifetime id, so isConfirmationVisualisationCurrent never takes it for the run of the new lifetime. Because every freshness check starts and ends within one background lifetime, persisting a generation would add nothing these counters do not already provide.
let activeNetworkWritesStarted = 0
let activeNetworkWritesFinished = 0

// Writes the active network, together with any other items of the same update, and counts the write.
export async function writeActiveNetwork(items: LocalStorageItems & { readonly activeRpcNetwork: RpcNetwork }) {
	activeNetworkWritesStarted += 1
	try {
		return await browser.storage.local.set(serializeLocalStorageItems(items))
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

// The background's read of the active network from items read from storage after isReadStillCurrent was taken by beginActiveNetworkRead: a corrupt stored value reads as the default network and is repaired to it through writeActiveNetwork. Page contexts use getActiveRpcNetworkWithoutRepair in pageSafeSettings.ts, which never writes.
export async function getActiveRpcNetworkOrRepairFromItems(storedItems: Readonly<Record<string, unknown>>, isReadStillCurrent: () => boolean, defaultRpcNetwork: RpcNetwork): Promise<RpcNetwork> {
	const { activeRpcNetwork: rawValue } = storedItems
	const storedNetwork = browserStorageLocalSafeParse(hasOwnKey(storedItems, 'activeRpcNetwork') ? { activeRpcNetwork: rawValue } : {})?.activeRpcNetwork
	if (storedNetwork !== undefined) return storedNetwork
	if (rawValue === undefined) return defaultRpcNetwork
	console.warn('activeRpcNetwork was corrupt:')
	console.warn(rawValue)
	// The corrupt value was read earlier, so a deliberate write of the active network, such as a network switch, may have started since; repairing then would replace the newer network with the default. So the repair is a compare-and-set on the write count: it writes only while the read is still current. The check and writeActiveNetwork's count of the new write run in one synchronous step, so no other write can start between them, and a write that starts later is issued after the repair and replaces it. A skipped repair leaves the corrupt value, if it is still stored, to the next read.
	if (isReadStillCurrent()) await writeActiveNetwork({ activeRpcNetwork: defaultRpcNetwork })
	return defaultRpcNetwork
}

export type ActiveNetworkSnapshot = {
	readonly activeRpcNetwork: RpcNetwork
	// Whether the network read is still the stored active network. It is not once a write of the active network was running when the read started, or has started since.
	readonly isStillCurrent: () => boolean
}

// Reads only the active network, repairing a corrupt stored value as getSettings does, together with a synchronous check of whether it is still current, for a reader that must act on the network that is stored when it acts.
export async function readActiveNetworkSnapshot(): Promise<ActiveNetworkSnapshot> {
	const defaultRpcNetwork = DEFAULT_RPCS[0]
	if (defaultRpcNetwork === undefined) throw new Error('default rpc was missing')
	const isStillCurrent = beginActiveNetworkRead()
	const activeRpcNetwork = await getActiveRpcNetworkOrRepairFromItems(await browser.storage.local.get(['activeRpcNetwork']), isStillCurrent, defaultRpcNetwork)
	return { activeRpcNetwork, isStillCurrent }
}
