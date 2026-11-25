import { getGnosisSafeContractSnapshot } from '../gnosisSafe/gnosisSafeCore.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumClientService } from '../simulation/serviceLifecycle.js'
import type { RequestGnosisSafeContractState } from '../types/interceptor-reply-messages.js'
import { getErrorMessage, reportUnexpectedError, shouldSuppressUnexpectedErrorReport } from '../utils/errors.js'
import { getPrimaryRpcForChain, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import type { RpcEntry } from '../types/rpc.js'

type GnosisSafeContractStateDependencies = {
	readonly getRpcEntry?: typeof getGnosisSafeContractRpcEntry
	readonly createTemporaryEthereum?: (rpcEntry: RpcEntry) => EthereumClientService
	readonly getSnapshot?: typeof getGnosisSafeContractSnapshot
	readonly getLocalEntries?: typeof getUserAddressBookEntriesForChainIdMorePreciseFirst
}

type GnosisSafeContractStateErrorReporter = (error: unknown, metadata: { code: string }) => Promise<unknown>

export async function handleGnosisSafeContractSnapshotFailure(error: unknown, reportError: GnosisSafeContractStateErrorReporter = reportUnexpectedError) {
	if (shouldSuppressUnexpectedErrorReport(error)) {
		return { ok: false as const, message: getErrorMessage(error) ?? 'Failed to retrieve Gnosis Safe signers.' }
	}
	await reportError(error, { code: 'safe_contract_state_retrieval_failed' })
	throw error
}

export async function getGnosisSafeContractRpcEntry(
	activeEthereum: Pick<EthereumClientService, 'getChainId' | 'getRpcEntry'>,
	chainId: bigint,
	getConfiguredRpcForChain: (chainId: bigint) => Promise<RpcEntry | undefined> = getPrimaryRpcForChain,
) {
	if (activeEthereum.getChainId() === chainId) return activeEthereum.getRpcEntry()
	return await getConfiguredRpcForChain(chainId)
}

function createTemporaryGnosisSafeEthereum(rpcEntry: RpcEntry) {
	return createEthereumClientService(
		rpcEntry,
		async () => undefined,
		async () => undefined,
	)
}

export async function requestGnosisSafeContractState(ethereum: EthereumClientService, request: RequestGnosisSafeContractState, dependencies: GnosisSafeContractStateDependencies = {}) {
	const { address, chainId } = request.data
	if (chainId === 'AllChains') return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: 'Gnosis Safe wallets must use a specific chain to load their signers.' } },
	}
	const rpcEntry = await (dependencies.getRpcEntry ?? getGnosisSafeContractRpcEntry)(ethereum, chainId)
	if (rpcEntry === undefined) return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: `Configure an RPC for chain ${ chainId.toString() } to load this Gnosis Safe's owners.` } },
	}
	const temporaryEthereum = ethereum.getChainId() === chainId
		? undefined
		: (dependencies.createTemporaryEthereum ?? createTemporaryGnosisSafeEthereum)(rpcEntry)
	const safeEthereum = temporaryEthereum ?? ethereum

	const safeSnapshot = await (dependencies.getSnapshot ?? getGnosisSafeContractSnapshot)(safeEthereum, address)
		.then(
			(snapshot) => ({ ok: true as const, snapshot }),
			handleGnosisSafeContractSnapshotFailure,
		)
		.finally(() => temporaryEthereum?.cleanup())
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
