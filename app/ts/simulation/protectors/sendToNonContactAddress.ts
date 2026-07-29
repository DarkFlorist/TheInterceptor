import type { EthereumAddress, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import type { SimulationState } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedEthereumEvents, TokenVisualizerResult } from '../../types/EnrichedEthereumData.js'
import { analyzeProxyTokenTransfer } from '../proxyTokenTransfer.js'
import { addressString } from '../../utils/bigint.js'

type IdentifyAddress = (address: EthereumAddress) => Promise<AddressBookEntry>

const getTokenTransferAmount = (tokenResult: TokenVisualizerResult) => tokenResult.isApproval || tokenResult.type === 'ERC721' ? 1n : tokenResult.amount

const getTokenId = (tokenResult: TokenVisualizerResult) => 'tokenId' in tokenResult ? tokenResult.tokenId : undefined

const getNotInAddressBookWarning = (destinations: readonly AddressBookEntry[]) => {
	const unknownDestinations = destinations.filter((destination) => destination.entrySource === 'OnChain')
	if (unknownDestinations.length === 0) return undefined
	if (unknownDestinations.length === 1) {
		const unknownDestination = unknownDestinations[0]
		if (unknownDestination === undefined) throw new Error('unknown destination was missing')
		return `This transaction sends funds to "${ unknownDestination.name }", which is not in the addressbook. Please add the address to addressbook to dismiss this error in the future.`
	}
	const destinationNames = unknownDestinations.map((destination) => `"${ destination.name }"`).join(', ')
	return `This transaction sends funds to ${ destinationNames }, which are not in the addressbook. Please add the addresses to addressbook to dismiss this error in the future.`
}

export async function getSendToNonContactWarning(transaction: EthereumUnsignedTransaction, events: EnrichedEthereumEvents, identify: IdentifyAddress) {
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
	if (proxyTransfer !== undefined) return getNotInAddressBookWarning(proxyTransfer.transferredTo.map((destination) => destination.entry))

	async function checkSendToAddress(to: EthereumAddress) {
		return getNotInAddressBookWarning([await identify(to)])
	}
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) {
		if (transaction.input.length === 0 && transaction.value > 0 && transaction.to !== null) return await checkSendToAddress(transaction.to)
		return
	}
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	return await checkSendToAddress(transferInfo.arguments.to)
}

export async function sendToNonContact(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState, eventsPromise: Promise<EnrichedEthereumEvents>) {
	const events = await eventsPromise
	return await getSendToNonContactWarning(transaction, events, async (address) => await identifyAddress(ethereum, requestAbortController, address))
}
