import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { EthereumAddress, EthereumQuantity } from '../types/wire-types.js'
import { BURN_ADDRESSES } from '../utils/constants.js'
import { findDeadEnds } from '../utils/findDeadEnds.js'
import { deduplicateByFunction } from '../utils/array.js'
import { addressString } from '../utils/bigint.js'

export type ProxyTokenTransferEvent<TSource> = {
	source: TSource
	from: AddressBookEntry
	to: AddressBookEntry
	tokenAddress: EthereumAddress
	tokenId: EthereumQuantity | undefined
	amount: EthereumQuantity
	isApproval: boolean
}

export type ProxyTokenTransferAnalysis<TSource> = {
	sourceTransfer: TSource
	transferRoute: readonly AddressBookEntry[]
	transferredFrom: { entry: AddressBookEntry, amountDelta: EthereumQuantity }
	transferredTo: readonly { entry: AddressBookEntry, amountDelta: EthereumQuantity }[]
	hasTransferFee: boolean
}

const PROXY_TRANSFER_MINIMUM_FORWARDED_NUMERATOR = 95n
const PROXY_TRANSFER_MINIMUM_FORWARDED_DENOMINATOR = 100n

const isContractLikeAddressBookEntry = (entry: AddressBookEntry) => (
	entry.type === 'contract'
	|| entry.type === 'ERC20'
	|| entry.type === 'ERC721'
	|| entry.type === 'ERC1155'
)

const isEnoughForwardedForProxyPayment = (forwardedAmount: bigint, sentAmount: bigint) => (
	sentAmount > 0n
	&& forwardedAmount <= sentAmount
	&& forwardedAmount * PROXY_TRANSFER_MINIMUM_FORWARDED_DENOMINATOR >= sentAmount * PROXY_TRANSFER_MINIMUM_FORWARDED_NUMERATOR
)

const getNetSums = (edges: readonly { from: EthereumAddress, to: EthereumAddress, amount: EthereumQuantity }[]) => {
	const netSums = new Map<bigint, bigint>()
	for (const edge of edges) {
		netSums.set(edge.from, (netSums.get(edge.from) || 0n) - edge.amount)
		netSums.set(edge.to, (netSums.get(edge.to) || 0n) + edge.amount)
	}
	return netSums
}

export function analyzeProxyTokenTransfer<TSource>({
	transactionFrom,
	transactionHasDestination,
	hasEnsEvents,
	tokenTransfers,
}: {
	transactionFrom: EthereumAddress
	transactionHasDestination: boolean
	hasEnsEvents: boolean
	tokenTransfers: readonly ProxyTokenTransferEvent<TSource>[]
}): ProxyTokenTransferAnalysis<TSource> | undefined {
	if (!transactionHasDestination || hasEnsEvents || tokenTransfers.length < 2) return undefined
	if (tokenTransfers.some((transfer) => BURN_ADDRESSES.includes(transfer.to.address) || BURN_ADDRESSES.includes(transfer.from.address))) return undefined
	if (tokenTransfers.some((transfer) => transfer.isApproval)) return undefined

	const senderTransfers = tokenTransfers.filter((transfer) => transfer.from.address === transactionFrom)
	const senderTransfer = senderTransfers[0]
	if (senderTransfers.length !== 1 || senderTransfer === undefined) return undefined
	if (!isContractLikeAddressBookEntry(senderTransfer.to)) return undefined
	if (tokenTransfers.some((transfer) => transfer.to.address === transactionFrom)) return undefined
	if (tokenTransfers.some((transfer) => transfer.tokenAddress !== senderTransfer.tokenAddress)) return undefined
	if (new Set(tokenTransfers.map((transfer) => transfer.tokenId)).size !== 1) return undefined

	const edges = tokenTransfers.map((transfer) => ({
		from: transfer.from.address,
		to: transfer.to.address,
		data: transfer.to,
		amount: transfer.amount,
	}))
	const deadEnds = findDeadEnds(edges, transactionFrom)
	if (deadEnds.size === 0) return undefined
	const netSums = getNetSums(edges)
	const sentAmount = -(netSums.get(transactionFrom) || 0n)
	if (sentAmount <= 0n) return undefined
	const positiveDeadEnds = Array.from(deadEnds)
		.map(([address, path]) => ({ path, amount: netSums.get(address) || 0n }))
		.filter((deadEnd) => deadEnd.amount > 0n)
	if (positiveDeadEnds.length === 0) return undefined
	const nonDuplicatedPath = positiveDeadEnds.flatMap(({ path }) => path.slice(0, -1))
	if (nonDuplicatedPath.length === 0) return undefined
	const forwardedAmount = positiveDeadEnds.reduce((total, current) => total + current.amount, 0n)
	if (!isEnoughForwardedForProxyPayment(forwardedAmount, sentAmount)) return undefined
	const transferRoute = deduplicateByFunction(
		positiveDeadEnds.flatMap(({ path }) => path.slice(0, -1).map((edge) => edge.data)),
		(entry: AddressBookEntry) => addressString(entry.address),
	)
	if (transferRoute === undefined) throw new Error('no path found')
	const transferredTo = positiveDeadEnds.map((deadEnd) => {
		const destinationEdge = deadEnd.path[deadEnd.path.length - 1]
		if (destinationEdge === undefined) throw new Error('path was missing')
		return { entry: destinationEdge.data, amountDelta: deadEnd.amount }
	})
	return {
		sourceTransfer: senderTransfer.source,
		transferRoute,
		transferredFrom: { entry: senderTransfer.from, amountDelta: sentAmount },
		transferredTo,
		hasTransferFee: forwardedAmount !== sentAmount,
	}
}
