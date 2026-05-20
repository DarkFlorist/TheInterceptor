import { addressString } from '../../utils/bigint.js'
import type { Erc721TokenApprovalChange, SimulatedAndVisualizedTransaction, ERC20TokenApprovalChange, Erc20TokenBalanceChange, TokenPriceEstimate, NamedTokenId } from '../../types/visualizer-types.js'
import type { AddressBookEntry, Erc1155Entry, Erc721Entry } from '../../types/addressBookTypes.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import type { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import { getFilledInContactEntry } from '../../utils/addressBookEntries.js'

type BalanceChangeSummary = {
	erc20TokenBalanceChanges: Map<string, bigint>, // token address, amount
	erc20TokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount

	erc721TokenBalanceChanges: Map<string, Map<string, boolean > >, // token address, token id, {true if received, false if sent}
	erc721and1155OperatorChanges: Map<string, string | undefined> // token address, operator
	erc721TokenIdApprovalChanges: Map<string, Map<string, string > > // token address, tokenId, approved address

	erc1155TokenBalanceChanges: Map<string, Map<string, bigint > >, // token address, token id, { amount }
}

type SummaryState = ReadonlyMap<string, BalanceChangeSummary>
type FallbackAddressMetadata = ReadonlyMap<string, AddressBookEntry>

export type Erc1155TokenBalanceChange = (Erc1155Entry & { changeAmount: bigint, tokenId: bigint })
export type Erc721and1155OperatorChange = ((Erc721Entry | Erc1155Entry) & { operator: AddressBookEntry | undefined })

export type SummaryOutcome = {
	summaryFor: AddressBookEntry
	erc20TokenBalanceChanges: Erc20TokenBalanceChange[]
	erc20TokenApprovalChanges: ERC20TokenApprovalChange[]

	erc721TokenBalanceChanges: (Erc721Entry & { received: boolean, tokenId: bigint })[]
	erc721and1155OperatorChanges: Erc721and1155OperatorChange[]
	erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[]

	erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[]
}

const createEmptyBalanceChangeSummary = (): BalanceChangeSummary => ({
	erc721TokenBalanceChanges: new Map(),
	erc721and1155OperatorChanges: new Map(),
	erc721TokenIdApprovalChanges: new Map(),

	erc1155TokenBalanceChanges: new Map(),

	erc20TokenApprovalChanges: new Map(),
	erc20TokenBalanceChanges: new Map(),
})

const cloneNestedMap = <Key, NestedKey, Value>(input: ReadonlyMap<Key, ReadonlyMap<NestedKey, Value>>) => {
	return new Map(Array.from(input, ([key, value]) => [key, new Map(value)]))
}

const cloneBalanceChangeSummary = (summary: BalanceChangeSummary): BalanceChangeSummary => ({
	erc20TokenBalanceChanges: new Map(summary.erc20TokenBalanceChanges),
	erc20TokenApprovalChanges: cloneNestedMap(summary.erc20TokenApprovalChanges),
	erc721TokenBalanceChanges: cloneNestedMap(summary.erc721TokenBalanceChanges),
	erc721and1155OperatorChanges: new Map(summary.erc721and1155OperatorChanges),
	erc721TokenIdApprovalChanges: cloneNestedMap(summary.erc721TokenIdApprovalChanges),
	erc1155TokenBalanceChanges: cloneNestedMap(summary.erc1155TokenBalanceChanges),
})

const prepareSummaries = (state: SummaryState, addresses: readonly string[]) => {
	const nextState = new Map(state)
	const preparedSummaries = new Map<string, BalanceChangeSummary>()

	for (const address of new Set(addresses)) {
		const summary = state.get(address)
		const clonedSummary = summary === undefined ? createEmptyBalanceChangeSummary() : cloneBalanceChangeSummary(summary)
		nextState.set(address, clonedSummary)
		preparedSummaries.set(address, clonedSummary)
	}

	return { nextState, preparedSummaries }
}

const cleanupErc20BalanceChange = (summary: BalanceChangeSummary, tokenAddress: string) => {
	if (summary.erc20TokenBalanceChanges.get(tokenAddress) === 0n) summary.erc20TokenBalanceChanges.delete(tokenAddress)
}

const cleanupErc1155BalanceChange = (summary: BalanceChangeSummary, tokenAddress: string, tokenId: string) => {
	if (summary.erc1155TokenBalanceChanges.get(tokenAddress)?.get(tokenId) === 0n) {
		summary.erc1155TokenBalanceChanges.get(tokenAddress)?.delete(tokenId)
	}
	if (summary.erc1155TokenBalanceChanges.get(tokenAddress)?.size === 0) {
		summary.erc1155TokenBalanceChanges.delete(tokenAddress)
	}
}

const isEmptyBalanceChangeSummary = (summary: BalanceChangeSummary) => {
	return (
		summary.erc721TokenBalanceChanges.size === 0 &&
		summary.erc721TokenIdApprovalChanges.size === 0 &&
		summary.erc20TokenApprovalChanges.size === 0 &&
		summary.erc20TokenBalanceChanges.size === 0 &&
		summary.erc1155TokenBalanceChanges.size === 0 &&
		summary.erc721and1155OperatorChanges.size === 0
	)
}

const buildFallbackAddressMetadata = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]): FallbackAddressMetadata => {
	const fallbackAddressMetadata = new Map<string, AddressBookEntry>()

	const addFallbackAddressMetadata = (entry: AddressBookEntry | undefined) => {
		if (entry === undefined) return
		fallbackAddressMetadata.set(addressString(entry.address), entry)
	}

	for (const transaction of transactions) {
		if (transaction === undefined) continue
		addFallbackAddressMetadata(transaction.transaction.from)
		for (const tokenEvent of extractTokenEvents(transaction.events)) {
			addFallbackAddressMetadata(tokenEvent.from)
			addFallbackAddressMetadata(tokenEvent.to)
		}
	}

	return fallbackAddressMetadata
}

const getAddressMetadata = (address: string, addressMetaData: ReadonlyMap<string, AddressBookEntry>, fallbackAddressMetadata: FallbackAddressMetadata) => {
	return addressMetaData.get(address) ?? fallbackAddressMetadata.get(address) ?? getFilledInContactEntry(BigInt(address))
}

const applyErc721Change = (state: SummaryState, from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata): SummaryState => {
	if (change.type !== 'ERC721') return state

	const { nextState, preparedSummaries } = prepareSummaries(state, change.isApproval ? [from] : [from, to])
	const fromSummary = preparedSummaries.get(from)
	if (fromSummary === undefined) throw new Error('from summary missing')

	if (change.isApproval) {
		if (!fromSummary.erc721TokenIdApprovalChanges.has(tokenAddress)) {
			fromSummary.erc721TokenIdApprovalChanges.set(tokenAddress, new Map())
		}
		fromSummary.erc721TokenIdApprovalChanges.get(tokenAddress)?.set(change.tokenId.toString(), to)
		return nextState
	}

	const tokenId = change.tokenId.toString()
	for (const value of [ { address: from, received: false }, { address: to, received: true } ]) {
		const addressSummary = preparedSummaries.get(value.address)
		if (addressSummary === undefined) throw new Error('address summary missing')
		if (!addressSummary.erc721TokenBalanceChanges.has(tokenAddress)) {
			addressSummary.erc721TokenBalanceChanges.set(tokenAddress, new Map())
		}
		const tokenBalanceChanges = addressSummary.erc721TokenBalanceChanges.get(tokenAddress)
		if (tokenBalanceChanges === undefined) throw new Error('token balance changes missing')
		if (tokenBalanceChanges.get(tokenId) === !value.received) {
			tokenBalanceChanges.delete(tokenId)
		} else {
			tokenBalanceChanges.set(tokenId, value.received)
		}
		if (!value.received) {
			addressSummary.erc721TokenIdApprovalChanges.get(tokenAddress)?.delete(tokenId)
		}
	}

	return nextState
}

const applyNftAllApprovalChange = (state: SummaryState, from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata): SummaryState => {
	if (change.type !== 'NFT All approval' || !change.isApproval) return state

	const { nextState, preparedSummaries } = prepareSummaries(state, [from])
	const fromSummary = preparedSummaries.get(from)
	if (fromSummary === undefined) throw new Error('from summary missing')
	fromSummary.erc721and1155OperatorChanges.set(tokenAddress, change.allApprovalAdded ? to : undefined)
	return nextState
}

const applyErc1155Change = (state: SummaryState, from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata): SummaryState => {
	if (change.type !== 'ERC1155' || change.isApproval) return state

	const { nextState, preparedSummaries } = prepareSummaries(state, [from, to])
	const fromSummary = preparedSummaries.get(from)
	if (fromSummary === undefined) throw new Error('from summary missing')
	const toSummary = preparedSummaries.get(to)
	if (toSummary === undefined) throw new Error('to summary missing')
	const tokenId = change.tokenId.toString()

	const fromTokenChanges = fromSummary.erc1155TokenBalanceChanges.get(tokenAddress) ?? new Map<string, bigint>()
	fromSummary.erc1155TokenBalanceChanges.set(tokenAddress, fromTokenChanges)
	const oldFromData = fromTokenChanges.get(tokenId) ?? 0n
	fromTokenChanges.set(tokenId, oldFromData - change.amount)

	const toTokenChanges = toSummary.erc1155TokenBalanceChanges.get(tokenAddress) ?? new Map<string, bigint>()
	toSummary.erc1155TokenBalanceChanges.set(tokenAddress, toTokenChanges)
	const oldToData = toTokenChanges.get(tokenId) ?? 0n
	toTokenChanges.set(tokenId, oldToData + change.amount)

	cleanupErc1155BalanceChange(toSummary, tokenAddress, tokenId)
	cleanupErc1155BalanceChange(fromSummary, tokenAddress, tokenId)

	return nextState
}

const applyErc20Change = (state: SummaryState, from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata): SummaryState => {
	if (change.type !== 'ERC20') return state

	if (change.isApproval) {
		const { nextState, preparedSummaries } = prepareSummaries(state, [from])
		const fromSummary = preparedSummaries.get(from)
		if (fromSummary === undefined) throw new Error('from summary missing')
		const tokenChanges = fromSummary.erc20TokenApprovalChanges.get(tokenAddress)
		if (tokenChanges === undefined) {
			fromSummary.erc20TokenApprovalChanges.set(tokenAddress, new Map([[to, change.amount]]))
		} else {
			tokenChanges.set(to, change.amount)
		}
		return nextState
	}

	const { nextState, preparedSummaries } = prepareSummaries(state, [from, to])
	const fromSummary = preparedSummaries.get(from)
	if (fromSummary === undefined) throw new Error('from summary missing')
	const toSummary = preparedSummaries.get(to)
	if (toSummary === undefined) throw new Error('to summary missing')

	const oldFromData = fromSummary.erc20TokenBalanceChanges.get(tokenAddress)
	fromSummary.erc20TokenBalanceChanges.set(tokenAddress, oldFromData === undefined ? -change.amount : oldFromData - change.amount)
	const oldToData = toSummary.erc20TokenBalanceChanges.get(tokenAddress)
	toSummary.erc20TokenBalanceChanges.set(tokenAddress, oldToData === undefined ? change.amount : oldToData + change.amount)

	cleanupErc20BalanceChange(toSummary, tokenAddress)
	cleanupErc20BalanceChange(fromSummary, tokenAddress)

	return nextState
}

const applyTokenChange = (state: SummaryState, change: TokenVisualizerResultWithMetadata): SummaryState => {
	const from = addressString(change.from.address)
	const to = addressString(change.to.address)
	const tokenAddress = addressString(change.token.address)

	switch (change.type) {
		case 'ERC1155': return applyErc1155Change(state, from, to, tokenAddress, change)
		case 'ERC721': return applyErc721Change(state, from, to, tokenAddress, change)
		case 'ERC20': return applyErc20Change(state, from, to, tokenAddress, change)
		case 'NFT All approval': return applyNftAllApprovalChange(state, from, to, tokenAddress, change)
	}
}

const applyGasFee = (state: SummaryState, result: SimulatedAndVisualizedTransaction): SummaryState => {
	const transactionSender = addressString(result.transaction.from.address)
	const { nextState, preparedSummaries } = prepareSummaries(state, [transactionSender])
	const senderSummary = preparedSummaries.get(transactionSender)
	if (senderSummary === undefined) throw new Error('sender summary is missing?')
	const ethAddress = addressString(ETHEREUM_LOGS_LOGGER_ADDRESS)
	const gasFee = result.gasSpent * result.realizedGasPrice
	const oldFromData = senderSummary.erc20TokenBalanceChanges.get(ethAddress)
	senderSummary.erc20TokenBalanceChanges.set(ethAddress, oldFromData === undefined ? -gasFee : oldFromData - gasFee)
	cleanupErc20BalanceChange(senderSummary, ethAddress)
	return nextState
}

const applyTransaction = (state: SummaryState, result: SimulatedAndVisualizedTransaction): SummaryState => {
	const stateAfterTokenChanges = extractTokenEvents(result.events).reduce(
		(currentState, change) => applyTokenChange(currentState, change),
		state,
	)
	return applyGasFee(stateAfterTokenChanges, result)
}

const buildSummaryState = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]): SummaryState => {
	const summaryState = transactions.reduce<SummaryState>(
		(currentState, transaction) => transaction === undefined ? currentState : applyTransaction(currentState, transaction),
		new Map<string, BalanceChangeSummary>(),
	)
	return new Map(Array.from(summaryState.entries()).filter(([_address, summary]) => !isEmptyBalanceChangeSummary(summary)))
}

const materializeSummaryForAddress = (summaryState: SummaryState, fallbackAddressMetadata: FallbackAddressMetadata, address: string, addressMetaData: ReadonlyMap<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]): Omit<SummaryOutcome, 'summaryFor'> | undefined => {
	const addressSummary = summaryState.get(address)
	if (addressSummary === undefined) return undefined

	const erc20TokenBalanceChanges: Erc20TokenBalanceChange[] = Array.from(addressSummary.erc20TokenBalanceChanges).map(([tokenAddress, changeAmount]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || metadata.type !== 'ERC20') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		const tokenPriceEstimate = tokenPriceEstimates.find((tokenEstimate) => addressString(tokenEstimate.token.address) === tokenAddress)
		const quoteTokenAddress = tokenPriceEstimate?.quoteToken.address
		const quoteTokenEntry = quoteTokenAddress === undefined ? undefined : addressMetaData.get(addressString(quoteTokenAddress))
		const tokenPriceEstimateQuoteToken = quoteTokenEntry?.type === 'ERC20' ? quoteTokenEntry : undefined
		return {
			...metadata,
			changeAmount,
			tokenPriceEstimate,
			tokenPriceEstimateQuoteToken
		}
	})

	const erc20TokenApprovalChanges: ERC20TokenApprovalChange[] = Array.from(addressSummary.erc20TokenApprovalChanges).map(([tokenAddress, approvals]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || metadata.type !== 'ERC20') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		return {
			...metadata,
			approvals: Array.from(approvals).map(([approvedAddress, change]) => ({
				...getAddressMetadata(approvedAddress, addressMetaData, fallbackAddressMetadata),
				change,
			})),
		}
	})

	const erc721TokenBalanceChanges: (Erc721Entry & { received: boolean, tokenId: bigint })[] = Array.from(addressSummary.erc721TokenBalanceChanges).flatMap(([tokenAddress, tokenIds]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		return Array.from(tokenIds).map(([tokenId, received]) => ({
			...metadata,
			tokenId: BigInt(tokenId),
			received,
		}))
	})

	const erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[] = Array.from(addressSummary.erc721TokenIdApprovalChanges).flatMap(([tokenAddress, approvals]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		return Array.from(approvals).map(([tokenId, approvedAddress]) => ({
			tokenEntry: metadata,
			tokenId: BigInt(tokenId),
			approvedEntry: getAddressMetadata(approvedAddress, addressMetaData, fallbackAddressMetadata),
		}))
	})

	const erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[] = Array.from(addressSummary.erc1155TokenBalanceChanges).flatMap(([tokenAddress, tokenIds]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || metadata.type !== 'ERC1155') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		return Array.from(tokenIds).map(([tokenId, changeAmount]) => ({
			...metadata,
			tokenId: BigInt(tokenId),
			tokenIdnName: namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === BigInt(tokenAddress) && namedTokenId.tokenId === BigInt(tokenId))?.tokenIdName,
			changeAmount,
		}))
	})

	const erc721and1155OperatorChanges: Erc721and1155OperatorChange[] = Array.from(addressSummary.erc721and1155OperatorChanges).map(([tokenAddress, operator]) => {
		const metadata = addressMetaData.get(tokenAddress)
		if (metadata === undefined || (metadata.type !== 'ERC1155' && metadata.type !== 'ERC721')) throw new Error(`Missing metadata for token: ${ tokenAddress }`)
		if (operator === undefined) {
			return {
				...metadata,
				operator: undefined,
			}
		}
		return {
			...metadata,
			operator: getAddressMetadata(operator, addressMetaData, fallbackAddressMetadata),
		}
	})

	return {
		erc20TokenBalanceChanges,
		erc20TokenApprovalChanges,
		erc721TokenBalanceChanges,
		erc721and1155OperatorChanges,
		erc721TokenIdApprovalChanges,
		erc1155TokenBalanceChanges,
	}
}

const buildSummaryArtifacts = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]) => ({
	summaryState: buildSummaryState(transactions),
	fallbackAddressMetadata: buildFallbackAddressMetadata(transactions),
})

export const summarizeLogsForAddress = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[], address: string, addressMetaData: ReadonlyMap<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]) => {
	const { summaryState, fallbackAddressMetadata } = buildSummaryArtifacts(transactions)
	return materializeSummaryForAddress(summaryState, fallbackAddressMetadata, address, addressMetaData, tokenPriceEstimates, namedTokenIds)
}

export const summarizeLogs = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[], addressMetaData: ReadonlyMap<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]) => {
	const { summaryState, fallbackAddressMetadata } = buildSummaryArtifacts(transactions)
	const summaries: SummaryOutcome[] = []
	for (const [address] of summaryState.entries()) {
		const summary = materializeSummaryForAddress(summaryState, fallbackAddressMetadata, address, addressMetaData, tokenPriceEstimates, namedTokenIds)
		if (summary === undefined) continue
		summaries.push({ summaryFor: getAddressMetadata(address, addressMetaData, fallbackAddressMetadata), ...summary })
	}
	return summaries
}
