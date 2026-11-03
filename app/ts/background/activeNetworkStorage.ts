import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import { type LocalStorageItems, browserStorageLocalSafeParse, serializeLocalStorageItems } from '../utils/storageUtils.js'
import { hasOwnKey } from '../utils/typescript.js'

// The background's only path that writes the stored active network, and the reads that must know whether a network they read is still stored. A transaction approval commits only against a network that is still stored, which readActiveNetworkSnapshot checks by counting writes, so the count and the write live together here and cannot be separated. The generic storage setter and remover in storageUtils.ts exclude the key at the type level, so writeActiveNetwork is the only typed way to write it. Page contexts compile their own copy of every module they import, whose counts the background would never see, so pageContextSettingsImports.test.ts keeps every page bundle from reaching this module; pages read the network through pageSafeSettings.ts. A raw browser.storage write would bypass the types and the counts, so the same test parses the application sources and allows browser.storage only as direct local.get calls, onChanged listeners, and local.set or local.remove calls in listed modules that never name the active network, rejecting clear and any alias of browser, browser.storage or browser.storage.local, apart from browser passed to a listed callee that uses it only as an identity key; the check is syntactic, so it cannot see the storage API reached without naming browser or chrome, such as through globalThis['browser'], and the keys those listed modules compute are checked by review.
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
function beginActiveNetworkRead() {
	const writesStartedBeforeRead = activeNetworkWritesStarted
	const writeRunningWhenReadStarted = activeNetworkWritesStarted !== activeNetworkWritesFinished
	return () => !writeRunningWhenReadStarted && activeNetworkWritesStarted === writesStartedBeforeRead
}

// The background's read of the active network: a corrupt stored value is repaired to the default network through writeActiveNetwork. Page contexts use getActiveRpcNetworkWithoutRepair in pageSafeSettings.ts, which never writes.
export async function getActiveRpcNetworkOrRepairFromItems(storedItems: Readonly<Record<string, unknown>>, defaultRpcNetwork: RpcNetwork): Promise<RpcNetwork> {
	const { activeRpcNetwork: rawValue } = storedItems
	const storedNetwork = browserStorageLocalSafeParse(hasOwnKey(storedItems, 'activeRpcNetwork') ? { activeRpcNetwork: rawValue } : {})?.activeRpcNetwork
	if (storedNetwork !== undefined) return storedNetwork
	if (rawValue === undefined) return defaultRpcNetwork
	console.warn('activeRpcNetwork was corrupt:')
	console.warn(rawValue)
	await writeActiveNetwork({ activeRpcNetwork: defaultRpcNetwork })
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
	const activeRpcNetwork = await getActiveRpcNetworkOrRepairFromItems(await browser.storage.local.get(['activeRpcNetwork']), defaultRpcNetwork)
	return { activeRpcNetwork, isStillCurrent }
}
