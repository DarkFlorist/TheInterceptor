import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet, safeParseLocalStorageItems } from '../utils/storageUtils.js'
import { hasOwnKey } from '../utils/typescript.js'

export type RpcConfigurationState =
	| { readonly status: 'ready', readonly rpcEntries: RpcEntries, readonly activeRpcNetwork: RpcNetwork }
	| { readonly status: 'unavailable', readonly reason: 'empty', readonly activeRpcNetwork: RpcNetwork }
	| { readonly status: 'unavailable', readonly reason: 'corrupt' | 'incomplete' | 'read-failed' | 'write-failed', readonly activeRpcNetwork?: RpcNetwork, readonly error?: unknown }

const rpcConfigurationRepairSemaphore = new Semaphore(1)

type RpcConfigurationStorageItems = Readonly<Record<string, unknown>> & {
	readonly rpcEntries?: unknown
	readonly activeRpcNetwork?: unknown
}

const reportCorruptStoredValue = (label: string) => (failure: unknown) => {
	console.warn(`${ label } was corrupt:`)
	console.warn(failure)
}

const unavailableRpcConfiguration = (reason: Exclude<Exclude<RpcConfigurationState, { status: 'ready' }>['reason'], 'empty'>, activeRpcNetwork?: RpcNetwork, error?: unknown): RpcConfigurationState => ({
	status: 'unavailable',
	reason,
	...(activeRpcNetwork === undefined ? {} : { activeRpcNetwork }),
	...(error === undefined ? {} : { error }),
})

type RpcConfigurationRepair = {
	readonly write: Parameters<typeof browserStorageLocalSet>[0]
	readonly readyConfiguration: Extract<RpcConfigurationState, { status: 'ready' }>
	readonly networkOnWriteFailure: RpcNetwork | undefined
}

function inspectRpcConfiguration(storedConfiguration: RpcConfigurationStorageItems): RpcConfigurationState | RpcConfigurationRepair {
	const hasRpcEntries = hasOwnKey(storedConfiguration, 'rpcEntries') && storedConfiguration.rpcEntries !== undefined
	const hasActiveRpcNetwork = hasOwnKey(storedConfiguration, 'activeRpcNetwork') && storedConfiguration.activeRpcNetwork !== undefined
	if (!hasRpcEntries && !hasActiveRpcNetwork) {
		const initialRpc = DEFAULT_RPCS[0]
		if (initialRpc === undefined) return unavailableRpcConfiguration('incomplete')
		return {
			write: { rpcEntries: DEFAULT_RPCS, activeRpcNetwork: initialRpc },
			readyConfiguration: { status: 'ready', rpcEntries: DEFAULT_RPCS, activeRpcNetwork: initialRpc },
			networkOnWriteFailure: undefined,
		}
	}

	let rpcEntries: RpcEntries | undefined
	let rpcEntriesAreCorrupt = false
	if (hasRpcEntries) {
		const parsedRpcEntries = safeParseLocalStorageItems({ rpcEntries: storedConfiguration.rpcEntries })
		if (!parsedRpcEntries.success || parsedRpcEntries.value.rpcEntries === undefined) {
			reportCorruptStoredValue('Rpc entries')(parsedRpcEntries)
			rpcEntriesAreCorrupt = true
		} else {
			rpcEntries = parsedRpcEntries.value.rpcEntries
		}
	}

	let activeRpcNetwork: RpcNetwork | undefined
	let activeRpcNetworkIsCorrupt = false
	if (hasActiveRpcNetwork) {
		const parsedActiveRpcNetwork = safeParseLocalStorageItems({ activeRpcNetwork: storedConfiguration.activeRpcNetwork })
		if (!parsedActiveRpcNetwork.success || parsedActiveRpcNetwork.value.activeRpcNetwork === undefined) {
			reportCorruptStoredValue('Active RPC network')(parsedActiveRpcNetwork)
			activeRpcNetworkIsCorrupt = true
		} else {
			activeRpcNetwork = parsedActiveRpcNetwork.value.activeRpcNetwork
		}
	}
	if (rpcEntriesAreCorrupt || activeRpcNetworkIsCorrupt) return unavailableRpcConfiguration('corrupt', activeRpcNetwork)

	if (rpcEntries === undefined) {
		if (activeRpcNetwork === undefined) return unavailableRpcConfiguration('incomplete')
		rpcEntries = activeRpcNetwork.httpsRpc === undefined ? [] : [activeRpcNetwork]
		return {
			write: { rpcEntries },
			readyConfiguration: { status: 'ready', rpcEntries, activeRpcNetwork },
			networkOnWriteFailure: activeRpcNetwork,
		}
	}
	if (rpcEntries.length === 0) {
		if (activeRpcNetwork !== undefined && activeRpcNetwork.httpsRpc === undefined) return { status: 'ready', rpcEntries, activeRpcNetwork }
		if (activeRpcNetwork === undefined) return unavailableRpcConfiguration('incomplete')
		return { status: 'unavailable', reason: 'empty', activeRpcNetwork }
	}
	if (activeRpcNetwork === undefined) {
		const selectedRpc = selectPrimaryRpc(rpcEntries)
		if (selectedRpc === undefined) return unavailableRpcConfiguration('incomplete')
		return {
			write: { activeRpcNetwork: selectedRpc },
			readyConfiguration: { status: 'ready', rpcEntries, activeRpcNetwork: selectedRpc },
			networkOnWriteFailure: selectedRpc,
		}
	}
	return { status: 'ready', rpcEntries, activeRpcNetwork }
}

async function inspectStoredRpcConfiguration(keys: readonly string[]) {
	let storedItems: Readonly<Record<string, unknown>>
	try {
		storedItems = await browser.storage.local.get([...keys, 'rpcEntries', 'activeRpcNetwork'])
	} catch (error: unknown) {
		return { storedItems: {}, configuration: unavailableRpcConfiguration('read-failed', undefined, error) }
	}
	return { storedItems, configuration: inspectRpcConfiguration(storedItems) }
}

export async function getRpcConfigurationStateWithStorageSnapshot(keys: readonly string[]): Promise<{ readonly storedItems: Readonly<Record<string, unknown>>, readonly rpcConfiguration: RpcConfigurationState }> {
	const { storedItems, configuration } = await inspectStoredRpcConfiguration(keys)
	if (!('write' in configuration)) return { storedItems, rpcConfiguration: configuration }
	// Only initialization and migration serialize. Reread inside the lock so a queued repair never uses the snapshot that prompted it.
	return await rpcConfigurationRepairSemaphore.execute(async () => {
		const { storedItems, configuration } = await inspectStoredRpcConfiguration(keys)
		if (!('write' in configuration)) return { storedItems, rpcConfiguration: configuration }
		try {
			await browserStorageLocalSet(configuration.write)
			return { storedItems, rpcConfiguration: configuration.readyConfiguration }
		} catch (error: unknown) {
			return { storedItems, rpcConfiguration: unavailableRpcConfiguration('write-failed', configuration.networkOnWriteFailure, error) }
		}
	})
}

// The snapshot resolver selects the primary entry, otherwise the first one.
function selectPrimaryRpc(rpcEntries: RpcEntries) {
	return rpcEntries.find((rpc) => rpc.primary) ?? rpcEntries[0]
}
