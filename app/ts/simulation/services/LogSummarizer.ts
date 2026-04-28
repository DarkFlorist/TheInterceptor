import { addressString } from '../../utils/bigint.js'
import { Erc721TokenApprovalChange, SimulatedAndVisualizedTransaction, ERC20TokenApprovalChange, Erc20TokenBalanceChange, TokenPriceEstimate, NamedTokenId } from '../../types/visualizer-types.js'
import { AddressBookEntry, Erc1155Entry, Erc721Entry } from '../../types/addressBookTypes.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import { getFilledInContactEntry } from '../../utils/addressBookEntries.js'

type BalanceChangeSummary = {
	erc20TokenBalanceChanges: Map<string, bigint>
	erc20TokenApprovalChanges: Map<string, Map<string, bigint>>
	erc721TokenBalanceChanges: Map<string, Map<string, boolean>>
	erc721and1155OperatorChanges: Map<string, string | undefined>
	erc721TokenIdApprovalChanges: Map<string, Map<string, string>>
	erc1155TokenBalanceChanges: Map<string, Map<string, bigint>>
}

export type Erc1155TokenBalanceChange = Erc1155Entry & { changeAmount: bigint, tokenId: bigint }
export type Erc721and1155OperatorChange = (Erc721Entry | Erc1155Entry) & { operator: AddressBookEntry | undefined }

export type SummaryOutcome = {
	summaryFor: AddressBookEntry
	erc20TokenBalanceChanges: Erc20TokenBalanceChange[]
	erc20TokenApprovalChanges: ERC20TokenApprovalChange[]
	erc721TokenBalanceChanges: (Erc721Entry & { received: boolean, tokenId: bigint })[]
	erc721and1155OperatorChanges: Erc721and1155OperatorChange[]
	erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[]
	erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[]
}

export interface LogSummarizer {
	getSummary(addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]): SummaryOutcome[]
	getSummaryForAddr(address: string, addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]): Omit<SummaryOutcome, 'summaryFor'> | undefined
}

const createEmptyBalanceChangeSummary = (): BalanceChangeSummary => ({
	erc721TokenBalanceChanges: new Map(),
	erc721and1155OperatorChanges: new Map(),
	erc721TokenIdApprovalChanges: new Map(),
	erc1155TokenBalanceChanges: new Map(),
	erc20TokenApprovalChanges: new Map(),
	erc20TokenBalanceChanges: new Map(),
})

const getOrCreateNestedMap = <K, V>(map: Map<string, Map<K, V>>, key: string) => {
	const existing = map.get(key)
	if (existing !== undefined) return existing
	const created = new Map<K, V>()
	map.set(key, created)
	return created
}

export function LogSummarizer(transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]): LogSummarizer {
	const summary = new Map<string, BalanceChangeSummary>()
	const fallbackAddressMetadata = new Map<string, AddressBookEntry>()

	const addFallbackAddressMetadata = (entry: AddressBookEntry | undefined) => {
		if (entry === undefined) return
		fallbackAddressMetadata.set(addressString(entry.address), entry)
	}

	const addFallbackMetadataFromTransaction = (transaction: SimulatedAndVisualizedTransaction) => {
		addFallbackAddressMetadata(transaction.transaction.from)
		for (const tokenEvent of extractTokenEvents(transaction.events)) {
			addFallbackAddressMetadata(tokenEvent.from)
			addFallbackAddressMetadata(tokenEvent.to)
		}
	}

	const getAddressMetadata = (address: string, addressMetaData: Map<string, AddressBookEntry>) => {
		return addressMetaData.get(address) ?? fallbackAddressMetadata.get(address) ?? getFilledInContactEntry(BigInt(address))
	}

	const getOrCreateAddressSummary = (address: string) => {
		const existing = summary.get(address)
		if (existing !== undefined) return existing
		const created = createEmptyBalanceChangeSummary()
		summary.set(address, created)
		return created
	}

	const updateErc721 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC721') return
		const fromSummary = getOrCreateAddressSummary(from)
		if (change.isApproval) {
			getOrCreateNestedMap(fromSummary.erc721TokenIdApprovalChanges, tokenAddress).set(change.tokenId.toString(), to)
			return
		}

		const tokenId = change.tokenId.toString()
		for (const value of [{ addr: from, received: false }, { addr: to, received: true }] as const) {
			const addressSummary = getOrCreateAddressSummary(value.addr)
			const tokenChanges = getOrCreateNestedMap(addressSummary.erc721TokenBalanceChanges, tokenAddress)
			if (tokenChanges.get(tokenId) === !value.received) tokenChanges.delete(tokenId)
			else tokenChanges.set(tokenId, value.received)

			if (!value.received) {
				addressSummary.erc721TokenIdApprovalChanges.get(tokenAddress)?.delete(tokenId)
			}
		}
	}

	const updateAllApproval = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'NFT All approval' || !change.isApproval) return
		const fromSummary = getOrCreateAddressSummary(from)
		fromSummary.erc721and1155OperatorChanges.set(tokenAddress, change.allApprovalAdded ? to : undefined)
	}

	const updateErc1155 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC1155' || change.isApproval) return

		const tokenId = change.tokenId.toString()
		const fromSummary = getOrCreateAddressSummary(from)
		const toSummary = getOrCreateAddressSummary(to)
		const fromTokenChanges = getOrCreateNestedMap(fromSummary.erc1155TokenBalanceChanges, tokenAddress)
		const toTokenChanges = getOrCreateNestedMap(toSummary.erc1155TokenBalanceChanges, tokenAddress)

		fromTokenChanges.set(tokenId, (fromTokenChanges.get(tokenId) ?? 0n) - change.amount)
		toTokenChanges.set(tokenId, (toTokenChanges.get(tokenId) ?? 0n) + change.amount)

		if (toTokenChanges.get(tokenId) === 0n) toTokenChanges.delete(tokenId)
		if (fromTokenChanges.get(tokenId) === 0n) fromTokenChanges.delete(tokenId)
		if (toTokenChanges.size === 0) toSummary.erc1155TokenBalanceChanges.delete(tokenAddress)
		if (fromTokenChanges.size === 0) fromSummary.erc1155TokenBalanceChanges.delete(tokenAddress)
	}

	const updateErc20 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC20') return
		const fromSummary = getOrCreateAddressSummary(from)
		if (change.isApproval) {
			getOrCreateNestedMap(fromSummary.erc20TokenApprovalChanges, tokenAddress).set(to, change.amount)
			return
		}

		const toSummary = getOrCreateAddressSummary(to)
		fromSummary.erc20TokenBalanceChanges.set(tokenAddress, (fromSummary.erc20TokenBalanceChanges.get(tokenAddress) ?? 0n) - change.amount)
		toSummary.erc20TokenBalanceChanges.set(tokenAddress, (toSummary.erc20TokenBalanceChanges.get(tokenAddress) ?? 0n) + change.amount)

		if (toSummary.erc20TokenBalanceChanges.get(tokenAddress) === 0n) toSummary.erc20TokenBalanceChanges.delete(tokenAddress)
		if (fromSummary.erc20TokenBalanceChanges.get(tokenAddress) === 0n) fromSummary.erc20TokenBalanceChanges.delete(tokenAddress)
	}

	const updateTokenChanges = (result: SimulatedAndVisualizedTransaction) => {
		for (const change of extractTokenEvents(result.events)) {
			const from = addressString(change.from.address)
			const to = addressString(change.to.address)
			const tokenAddress = addressString(change.token.address)

			getOrCreateAddressSummary(from)
			getOrCreateAddressSummary(to)
			updateErc1155(from, to, tokenAddress, change)
			updateErc721(from, to, tokenAddress, change)
			updateErc20(from, to, tokenAddress, change)
			updateAllApproval(from, to, tokenAddress, change)
		}

		const transactionSender = addressString(result.transaction.from.address)
		const senderSummary = getOrCreateAddressSummary(transactionSender)
		const ethAddress = addressString(ETHEREUM_LOGS_LOGGER_ADDRESS)
		const gasFee = result.gasSpent * result.realizedGasPrice
		senderSummary.erc20TokenBalanceChanges.set(ethAddress, (senderSummary.erc20TokenBalanceChanges.get(ethAddress) ?? 0n) - gasFee)
		if (senderSummary.erc20TokenBalanceChanges.get(ethAddress) === 0n) senderSummary.erc20TokenBalanceChanges.delete(ethAddress)
	}

	const summarizeToAddressChanges = () => {
		for (const transaction of transactions) {
			if (transaction === undefined) continue
			updateTokenChanges(transaction)
		}
	}

	const getSummaryForAddr = (address: string, addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]): Omit<SummaryOutcome, 'summaryFor'> | undefined => {
		const addressSummary = summary.get(address)
		if (addressSummary === undefined) return undefined

		const erc20TokenBalanceChanges: Erc20TokenBalanceChange[] = Array.from(addressSummary.erc20TokenBalanceChanges).map(([tokenAddress, changeAmount]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC20') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			const tokenPriceEstimate = tokenPriceEstimates.find((estimate) => addressString(estimate.token.address) === tokenAddress)
			const quoteTokenAddress = tokenPriceEstimate?.quoteToken.address
			const quoteTokenEntry = quoteTokenAddress === undefined ? undefined : addressMetaData.get(addressString(quoteTokenAddress))
			return {
				...metadata,
				changeAmount,
				tokenPriceEstimate,
				tokenPriceEstimateQuoteToken: quoteTokenEntry?.type === 'ERC20' ? quoteTokenEntry : undefined,
			}
		})

		const erc20TokenApprovalChanges: ERC20TokenApprovalChange[] = Array.from(addressSummary.erc20TokenApprovalChanges).map(([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC20') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return {
				...metadata,
				approvals: Array.from(approvals).map(([approvedAddress, change]) => ({ ...getAddressMetadata(approvedAddress, addressMetaData), change })),
			}
		})

		const erc721TokenBalanceChanges = Array.from(addressSummary.erc721TokenBalanceChanges).flatMap(([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return Array.from(tokenIds).map(([tokenId, received]) => ({ ...metadata, tokenId: BigInt(tokenId), received }))
		})

		const erc721TokenIdApprovalChanges = Array.from(addressSummary.erc721TokenIdApprovalChanges).flatMap(([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return Array.from(approvals).map(([tokenId, approvedAddress]) => ({
				tokenEntry: metadata,
				tokenId: BigInt(tokenId),
				approvedEntry: getAddressMetadata(approvedAddress, addressMetaData),
			}))
		})

		const erc1155TokenBalanceChanges = Array.from(addressSummary.erc1155TokenBalanceChanges).flatMap(([tokenAddress, tokenIds]) => {
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
			return {
				...metadata,
				operator: operator === undefined ? undefined : getAddressMetadata(operator, addressMetaData),
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

	const getSummary = (addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]) => {
		const summaries: SummaryOutcome[] = []
		for (const [address] of summary.entries()) {
			const currentSummary = getSummaryForAddr(address, addressMetaData, tokenPriceEstimates, namedTokenIds)
			if (currentSummary === undefined) continue
			summaries.push({ summaryFor: getAddressMetadata(address, addressMetaData), ...currentSummary })
		}
		return summaries
	}

	for (const transaction of transactions) {
		if (transaction === undefined) continue
		addFallbackMetadataFromTransaction(transaction)
	}
	summarizeToAddressChanges()

	for (const [address, addressSummary] of Array.from(summary.entries())) {
		if (
			addressSummary.erc721TokenBalanceChanges.size === 0 &&
			addressSummary.erc721TokenIdApprovalChanges.size === 0 &&
			addressSummary.erc20TokenApprovalChanges.size === 0 &&
			addressSummary.erc20TokenBalanceChanges.size === 0 &&
			addressSummary.erc1155TokenBalanceChanges.size === 0 &&
			addressSummary.erc721and1155OperatorChanges.size === 0
		) {
			summary.delete(address)
		}
	}

	return {
		getSummary,
		getSummaryForAddr,
	}
}
