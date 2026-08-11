import { getSafeContractSnapshot, isSafeContractValidationFailure } from '../safe/safeCore.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { RequestSafeContractState } from '../types/interceptor-reply-messages.js'
import { getErrorMessage, isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { getPrimaryRpcForChain, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { createSimulationServices } from '../simulation/serviceLifecycle.js'
import type { RpcEntry } from '../types/rpc.js'

type SafeContractStateDependencies = {
	readonly getRpcEntry?: typeof getSafeContractRpcEntry
	readonly createTemporaryEthereum?: (rpcEntry: RpcEntry) => { ethereum: EthereumClientService, cleanup: () => void }
	readonly getSnapshot?: typeof getSafeContractSnapshot
	readonly getLocalEntries?: typeof getUserAddressBookEntriesForChainIdMorePreciseFirst
}

type SafeContractStateErrorReporter = (error: unknown, metadata: { code: string }) => Promise<unknown>

export async function handleSafeContractSnapshotFailure(error: unknown, reportError: SafeContractStateErrorReporter = reportUnexpectedError) {
	if (isExpectedInfrastructureError(error) || isSafeContractValidationFailure(error)) {
		return { ok: false as const, message: getErrorMessage(error) ?? 'Failed to retrieve Gnosis Safe signers.' }
	}
	await reportError(error, { code: 'safe_contract_state_retrieval_failed' })
	throw error
}

export async function getSafeContractRpcEntry(
	activeEthereum: Pick<EthereumClientService, 'getChainId' | 'getRpcEntry'>,
	chainId: bigint,
	getConfiguredRpcForChain: (chainId: bigint) => Promise<RpcEntry | undefined> = getPrimaryRpcForChain,
) {
	if (activeEthereum.getChainId() === chainId) return activeEthereum.getRpcEntry()
	return await getConfiguredRpcForChain(chainId)
}

function createTemporarySafeEthereum(rpcEntry: RpcEntry) {
	const services = createSimulationServices(rpcEntry, async () => undefined, async () => undefined)
	return { ethereum: services.ethereum, cleanup: () => services.ethereum.cleanup() }
}

export async function requestSafeContractState(ethereum: EthereumClientService, request: RequestSafeContractState, dependencies: SafeContractStateDependencies = {}) {
	const { address, chainId } = request.data
	if (chainId === 'AllChains') return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: 'Gnosis Safe wallets must use a specific chain to load their signers.' } },
	}
	const rpcEntry = await (dependencies.getRpcEntry ?? getSafeContractRpcEntry)(ethereum, chainId)
	if (rpcEntry === undefined) return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: `Configure an RPC for chain ${ chainId.toString() } to load this Gnosis Safe's owners.` } },
	}
	const temporaryEthereum = ethereum.getChainId() === chainId
		? undefined
		: (dependencies.createTemporaryEthereum ?? createTemporarySafeEthereum)(rpcEntry)
	const safeEthereum = temporaryEthereum?.ethereum ?? ethereum

	const safeSnapshot = await (dependencies.getSnapshot ?? getSafeContractSnapshot)(safeEthereum, address).then(
		(snapshot) => ({ ok: true as const, snapshot }),
		handleSafeContractSnapshotFailure,
	).finally(() => temporaryEthereum?.cleanup())
	if (!safeSnapshot.ok) return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: safeSnapshot },
	}

	const { state } = safeSnapshot.snapshot
	const localEntries = await (dependencies.getLocalEntries ?? getUserAddressBookEntriesForChainIdMorePreciseFirst)(chainId)
	const ownerAddresses = new Set(state.owners)
	const ownerAddressBookEntries = localEntries.filter((entry) => ownerAddresses.has(entry.address))
	return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: true as const, owners: state.owners, ownerAddressBookEntries, version: state.version } },
	}
}
