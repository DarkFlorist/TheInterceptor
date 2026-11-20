import type { EthereumAddress, EthereumUnsignedTransaction } from '../types/wire-types.js'
import { parseTransaction } from '../utils/calldata.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { EnrichedEthereumEvents, TokenVisualizerResult } from '../types/EnrichedEthereumData.js'
import { analyzeProxyTokenTransfer } from './proxyTokenTransfer.js'
import { addressString } from '../utils/bigint.js'

export type IdentifyAddress = (address: EthereumAddress) => Promise<AddressBookEntry>

const getTokenTransferAmount = (tokenResult: TokenVisualizerResult) => tokenResult.isApproval || tokenResult.type === 'ERC721' ? 1n : tokenResult.amount

const getTokenId = (tokenResult: TokenVisualizerResult) => 'tokenId' in tokenResult ? tokenResult.tokenId : undefined

// Returns the final recipients of a proxied token transfer, or else the recipient of a direct token transfer call or plain ether send, and no recipients for other transactions.
export async function getFundsDestinations(transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents, identify: IdentifyAddress): Promise<readonly AddressBookEntry[]> {
	const tokenResults = events
		.filter((event) => event.type === 'TokenEvent')
		.map((event) => event.logInformation)
	const addresses = Array.from(new Set(tokenResults.flatMap((tokenResult) => [tokenResult.from, tokenResult.to])))
	const entries = await Promise.all(addresses.map(async (address) => [addressString(address), await identify(address)] as const))
	const entriesByAddress = new Map(entries)
	const proxyTransfer = analyzeProxyTokenTransfer({
		transactionFrom: transaction.from,
		transactionHasDestination: transaction.to !== null,
		hasEnsEvents: events.some((event) => event.type === 'ENS'),
		tokenTransfers: tokenResults.map((tokenResult) => {
			const from = entriesByAddress.get(addressString(tokenResult.from))
			const to = entriesByAddress.get(addressString(tokenResult.to))
			if (from === undefined || to === undefined) throw new Error('missing proxy transfer address metadata')
			return {
				source: tokenResult,
				from,
				to,
				tokenAddress: tokenResult.tokenAddress,
				tokenId: getTokenId(tokenResult),
				amount: getTokenTransferAmount(tokenResult),
				isApproval: tokenResult.isApproval,
			}
		}),
	})
	if (proxyTransfer !== undefined) return proxyTransfer.transferredTo.map((destination) => destination.entry)

	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) {
		if (transaction.input.length === 0 && transaction.value > 0 && transaction.to !== null) return [await identify(transaction.to)]
		return []
	}
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return []
	return [await identify(transferInfo.arguments.to)]
}
