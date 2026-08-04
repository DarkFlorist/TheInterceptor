import { getSafeContractSnapshot } from '../safe/safeCore.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { RequestSafeContractState } from '../types/interceptor-reply-messages.js'
import { getErrorMessage } from '../utils/errors.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

export async function requestSafeContractState(ethereum: EthereumClientService, request: RequestSafeContractState) {
	const { address, chainId } = request.data
	if (chainId === 'AllChains') return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: 'Gnosis Safe wallets must use a specific chain to load their signers.' } },
	}
	if (chainId !== ethereum.getChainId()) return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: false as const, message: `Switch Interceptor to chain ${ chainId.toString() } to load this Gnosis Safe's signers.` } },
	}

	const safeSnapshot = await getSafeContractSnapshot(ethereum, address).then(
		(snapshot) => ({ ok: true as const, snapshot }),
		(error: unknown) => ({ ok: false as const, message: getErrorMessage(error) ?? 'Failed to retrieve Gnosis Safe signers.' }),
	)
	if (!safeSnapshot.ok) return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: safeSnapshot },
	}

	const { state } = safeSnapshot.snapshot
	const localEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)
	const ownerAddresses = new Set(state.owners)
	const ownerAddressBookEntries = localEntries.filter((entry) => ownerAddresses.has(entry.address))
	return {
		method: 'popup_requestSafeContractState' as const,
		data: { chainId, result: { ok: true as const, owners: state.owners, ownerAddressBookEntries, version: state.version } },
	}
}
