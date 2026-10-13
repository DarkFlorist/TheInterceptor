import { DEFAULT_RPCS } from '../config/defaults.js'
import type { RpcEntries, RpcNetwork } from '../types/rpc.js'
import { getChainName } from '../utils/constants.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import { getRpcEntryIdentityKey } from '../utils/rpcNetworkChange.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet, safeParseLocalStorageItems } from '../utils/storageUtils.js'
import { hasOwnKey, modifyObject } from '../utils/typescript.js'

export type RpcConfigurationState =
	| { readonly status: 'ready', readonly rpcEntries: RpcEntries, readonly activeRpcNetwork: RpcNetwork }
	| { readonly status: 'unavailable', readonly reason: 'empty', readonly activeRpcNetwork: RpcNetwork }
	| { readonly status: 'unavailable', readonly reason: 'corrupt' | 'incomplete' | 'read-failed' | 'write-failed', readonly activeRpcNetwork?: RpcNetwork, readonly error?: unknown }

const rpcConfigurationSemaphore = new Semaphore(1)

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

async function resolveRpcConfigurationStateWithoutLock(storedConfiguration: RpcConfigurationStorageItems): Promise<RpcConfigurationState> {
	const hasRpcEntries = hasOwnKey(storedConfiguration, 'rpcEntries') && storedConfiguration.rpcEntries !== undefined
	const hasActiveRpcNetwork = hasOwnKey(storedConfiguration, 'activeRpcNetwork') && storedConfiguration.activeRpcNetwork !== undefined
	if (!hasRpcEntries && !hasActiveRpcNetwork) {
		const initialRpc = DEFAULT_RPCS[0]
		if (initialRpc === undefined) return unavailableRpcConfiguration('incomplete')
		try {
			await browserStorageLocalSet({ rpcEntries: DEFAULT_RPCS, activeRpcNetwork: initialRpc })
			return { status: 'ready', rpcEntries: DEFAULT_RPCS, activeRpcNetwork: initialRpc }
		} catch (error: unknown) {
			return unavailableRpcConfiguration('write-failed', undefined, error)
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
		try {
			await browserStorageLocalSet({ rpcEntries })
		} catch (error: unknown) {
			return unavailableRpcConfiguration('write-failed', activeRpcNetwork, error)
		}
	}
	if (rpcEntries.length === 0) {
		if (activeRpcNetwork !== undefined && activeRpcNetwork.httpsRpc === undefined) return { status: 'ready', rpcEntries, activeRpcNetwork }
		if (activeRpcNetwork === undefined) return unavailableRpcConfiguration('incomplete')
		return { status: 'unavailable', reason: 'empty', activeRpcNetwork }
	}
	if (activeRpcNetwork === undefined) {
		const selectedRpc = rpcEntries.find((entry) => entry.primary) ?? rpcEntries[0]
		if (selectedRpc === undefined) return unavailableRpcConfiguration('incomplete')
		activeRpcNetwork = selectedRpc
		try {
			await browserStorageLocalSet({ activeRpcNetwork })
		} catch (error: unknown) {
			return unavailableRpcConfiguration('write-failed', activeRpcNetwork, error)
		}
	}
	return { status: 'ready', rpcEntries, activeRpcNetwork }
}

async function getRpcConfigurationStateWithoutLock(): Promise<RpcConfigurationState> {
	let storedConfiguration: Readonly<Record<string, unknown>>
	try {
		storedConfiguration = await browser.storage.local.get(['rpcEntries', 'activeRpcNetwork'])
	} catch (error: unknown) {
		return unavailableRpcConfiguration('read-failed', undefined, error)
	}
	return await resolveRpcConfigurationStateWithoutLock(storedConfiguration)
}

export async function getRpcConfigurationState(): Promise<RpcConfigurationState> {
	return await rpcConfigurationSemaphore.execute(getRpcConfigurationStateWithoutLock)
}

export async function getRpcConfigurationStateWithStorageSnapshot(keys: readonly string[]): Promise<{ readonly storedItems: Readonly<Record<string, unknown>>, readonly rpcConfiguration: RpcConfigurationState }> {
	return await rpcConfigurationSemaphore.execute(async () => {
		let storedItems: Readonly<Record<string, unknown>>
		try {
			storedItems = await browser.storage.local.get([...keys, 'rpcEntries', 'activeRpcNetwork'])
		} catch (error: unknown) {
			return { storedItems: {}, rpcConfiguration: unavailableRpcConfiguration('read-failed', undefined, error) }
		}
		return { storedItems, rpcConfiguration: await resolveRpcConfigurationStateWithoutLock(storedItems) }
	})
}

export async function setRpcConfiguration(rpcEntries: RpcEntries, activeRpcNetwork: RpcNetwork) {
	await rpcConfigurationSemaphore.execute(async () => await browserStorageLocalSet({ rpcEntries, activeRpcNetwork }))
}

export const setRpcList = async (rpcEntries: RpcEntries) => await rpcConfigurationSemaphore.execute(async () => await browserStorageLocalSet({ rpcEntries }))

export async function getRpcList(): Promise<RpcEntries> {
	const state = await getRpcConfigurationState()
	if (state.status === 'ready') return state.rpcEntries
	if ('error' in state && state.error !== undefined) throw state.error
	throw createRpcConfigurationUnavailableError()
}

export const promoteRpcAsPrimary = async (rpcNetwork: RpcNetwork) => {
	await rpcConfigurationSemaphore.execute(async () => {
		const state = await getRpcConfigurationStateWithoutLock()
		if (state.status !== 'ready') {
			if ('error' in state && state.error !== undefined) throw state.error
			throw createRpcConfigurationUnavailableError()
		}
		const selectedIndex = state.rpcEntries.findIndex((rpc) => getRpcEntryIdentityKey(rpc) === getRpcEntryIdentityKey(rpcNetwork))
		if (selectedIndex === -1) return
		await browserStorageLocalSet({ rpcEntries: state.rpcEntries.map((rpc, index) => rpc.chainId === rpcNetwork.chainId ? modifyObject(rpc, { primary: index === selectedIndex }) : rpc) })
	})
}

export const getPrimaryRpcForChain = async (chainId: bigint) => {
	const rpcs = await getRpcList()
	return rpcs.find((rpc) => rpc.chainId === chainId && rpc.primary) ?? rpcs.find((rpc) => rpc.chainId === chainId)
}

export const getRpcNetworkForChain = async (chainId: bigint): Promise<RpcNetwork> => {
	const rpc = await getPrimaryRpcForChain(chainId)
	if (rpc !== undefined) return rpc
	return {
		chainId,
		currencyName: 'Ether?',
		currencyTicker: 'ETH?',
		name: getChainName(chainId),
		httpsRpc: undefined,
		primary: false,
		minimized: true,
	}
}
