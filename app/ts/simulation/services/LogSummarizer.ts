import { addressString } from '../../utils/bigint.js'
import { Erc721TokenApprovalChange, SimulatedAndVisualizedTransaction, ERC20TokenApprovalChange, Erc20TokenBalanceChange, TokenPriceEstimate, NamedTokenId } from '../../types/visualizer-types.js'
import { AddressBookEntry, Erc1155Entry, Erc721Entry } from '../../types/addressBookTypes.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../utils/constants.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
export type BalanceChangeSummary = {
	erc20TokenBalanceChanges: Map<string, bigint>, // token address, amount
	erc20TokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount

	erc721TokenBalanceChanges: Map<string, Map<string, boolean > >, // token address, token id, {true if received, false if sent}
	erc721and1155OperatorChanges: Map<string, string | undefined> // token address, operator
	erc721TokenIdApprovalChanges: Map<string, Map<string, string > > // token address, tokenId, approved address

	erc1155TokenBalanceChanges: Map<string, Map<string, bigint > >, // token address, token id, { amount }
}

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

export class LogSummarizer {
	private summary = new Map<string, BalanceChangeSummary>()

	private ensureAddressInSummary = (address: string) => {
		if ( !this.summary.has(address)) {
			this.summary.set(address, {
				erc721TokenBalanceChanges: new Map(),
				erc721and1155OperatorChanges: new Map(),
				erc721TokenIdApprovalChanges: new Map(),

				erc1155TokenBalanceChanges: new Map(),

				erc20TokenApprovalChanges: new Map(),
				erc20TokenBalanceChanges: new Map(),
			})
		}
	}

	private updateErc721 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC721') return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if (!fromSummary.erc721TokenIdApprovalChanges.has(tokenAddress)) {
				fromSummary.erc721TokenIdApprovalChanges.set(tokenAddress, new Map())
			}
			const thisToken = fromSummary.erc721TokenIdApprovalChanges.get(tokenAddress)!
			thisToken.set(change.tokenId.toString(), to)
		} else {
			const tokenId = change.tokenId.toString()
			// track balance changes
			for (const val of [ { addr: from, received: false }, { addr: to, received: true } ]) {
				const addrSummary = this.summary.get(val.addr)!
				if (!addrSummary.erc721TokenBalanceChanges.has(tokenAddress)) {
					addrSummary.erc721TokenBalanceChanges.set(tokenAddress, new Map())
				}
				const token = addrSummary.erc721TokenBalanceChanges.get(tokenAddress)!
				if ( token.get(tokenId) === !val.received) { // if we have received and sent, we can clear the entry as there's no change to state
					token.delete(tokenId)
				} else {
					addrSummary.erc721TokenBalanceChanges.get(tokenAddress)?.set(tokenId, val.received)
				}
				// clear added approvals if any on transfer
				if (!val.received) {
					const approvalChanges = this.summary.get(val.addr)?.erc721TokenIdApprovalChanges.get(tokenAddress)
					if(approvalChanges) {
						approvalChanges.delete(tokenId)
					}
				}
			}
		}
	}

	private updateAllApproval = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'NFT All approval') return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if (change.type === 'NFT All approval') {
				if (change.allApprovalAdded) {
					fromSummary.erc721and1155OperatorChanges.set(tokenAddress, to)
				} else {
					fromSummary.erc721and1155OperatorChanges.set(tokenAddress, undefined)
				}
				return
			}
		}
	}
	private updateErc1155 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC1155') return
		if (!change.isApproval) {
			// track balance changes
			const fromSummary = this.summary.get(from)
			if (fromSummary === undefined) throw new Error('from summary missing')
			const toSummary = this.summary.get(to)
			if (toSummary === undefined) throw new Error('to summary missing')

			const oldFromData = (fromSummary.erc1155TokenBalanceChanges.get(tokenAddress) || new Map<string, bigint>()).get(change.tokenId.toString()) || 0n
			if (fromSummary.erc1155TokenBalanceChanges.get(tokenAddress) === undefined) fromSummary.erc1155TokenBalanceChanges.set(tokenAddress, new Map<string, bigint>())
			fromSummary.erc1155TokenBalanceChanges.get(tokenAddress)!.set(change.tokenId.toString(), oldFromData - change.amount)

			const oldToData = (toSummary.erc1155TokenBalanceChanges.get(tokenAddress) || new Map<string, bigint>()).get(change.tokenId.toString()) || 0n
			if (toSummary.erc1155TokenBalanceChanges.get(tokenAddress) === undefined) toSummary.erc1155TokenBalanceChanges.set(tokenAddress, new Map<string, bigint>())
			toSummary.erc1155TokenBalanceChanges.get(tokenAddress)!.set(change.tokenId.toString(), oldToData + change.amount)

			// clean if change is now zero
			if (this.summary.get(to)!.erc1155TokenBalanceChanges.get(tokenAddress)?.get(change.tokenId.toString()) === 0n) {
				this.summary.get(to)!.erc1155TokenBalanceChanges.get(tokenAddress)?.delete(change.tokenId.toString())
			}
			if (this.summary.get(to)!.erc1155TokenBalanceChanges.get(tokenAddress)?.size === 0) {
				this.summary.get(to)!.erc1155TokenBalanceChanges.delete(tokenAddress)
			}
			// clean if change is now zero
			if (this.summary.get(from)!.erc1155TokenBalanceChanges.get(tokenAddress)?.get(change.tokenId.toString())=== 0n) {
				this.summary.get(from)!.erc1155TokenBalanceChanges.get(tokenAddress)?.delete(change.tokenId.toString())
			}
			if (this.summary.get(from)!.erc1155TokenBalanceChanges.get(tokenAddress)?.size === 0) {
				this.summary.get(from)!.erc1155TokenBalanceChanges.delete(tokenAddress)
			}
		}
	}
	private updateErc20 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC20') return
		if (change.isApproval) {
			// track approvals
			const tokenChanges = this.summary.get(from)!.erc20TokenApprovalChanges.get(tokenAddress)
			if (tokenChanges === undefined) {
				this.summary.get(from)!.erc20TokenApprovalChanges.set(tokenAddress, new Map([[to, change.amount]]))
			} else {
				tokenChanges.set(to, change.amount)
			}
			// TODO: add tracking on how transfers modify the approval number (this requires changes in visualizer results)
		} else {
			// track balance changes
			const oldFromData = this.summary.get(from)!.erc20TokenBalanceChanges.get(tokenAddress)
			this.summary.get(from)!.erc20TokenBalanceChanges.set(tokenAddress, oldFromData === undefined ? -change.amount : oldFromData - change.amount)
			const oldToData = this.summary.get(to)!.erc20TokenBalanceChanges.get(tokenAddress)
			this.summary.get(to)!.erc20TokenBalanceChanges.set(tokenAddress, oldToData === undefined ? change.amount : oldToData + change.amount)

			// clean if change is now zero
			if (this.summary.get(to)!.erc20TokenBalanceChanges.get(tokenAddress) === 0n) {
				this.summary.get(to)!.erc20TokenBalanceChanges.delete(tokenAddress)
			}
			// clean if change is now zero
			if (this.summary.get(from)!.erc20TokenBalanceChanges.get(tokenAddress) === 0n) {
				this.summary.get(from)!.erc20TokenBalanceChanges.delete(tokenAddress)
			}
		}
	}

	private updateTokenChanges = (result: SimulatedAndVisualizedTransaction) => {
		for (const change of extractTokenEvents(result.events)) {
			const from = addressString(change.from.address)
			const to = addressString(change.to.address)
			const tokenAddress = addressString(change.token.address)

			for (const address of [from, to]) this.ensureAddressInSummary(address)

			this.updateErc1155(from, to, tokenAddress, change)
			this.updateErc721(from, to, tokenAddress, change)
			this.updateErc20(from, to, tokenAddress, change)
			this.updateAllApproval(from, to, tokenAddress, change)
		}

		// update gas fees
		const transactionSender = addressString(result.transaction.from.address)
		this.ensureAddressInSummary(transactionSender)
		const ethAddress = addressString(ETHEREUM_LOGS_LOGGER_ADDRESS)
		const gasFee = result.gasSpent * result.realizedGasPrice
		const senderSummary = this.summary.get(transactionSender)
		if (senderSummary === undefined) throw new Error('sender summary is missing?')
		const oldFromData = senderSummary.erc20TokenBalanceChanges.get(ethAddress)
		senderSummary.erc20TokenBalanceChanges.set(ethAddress, oldFromData === undefined ? -gasFee : oldFromData - gasFee)

		// clean if change is now zero
		if (senderSummary.erc20TokenBalanceChanges.get(ethAddress) === 0n) senderSummary.erc20TokenBalanceChanges.delete(ethAddress)
	}

	private summarizeToAddressChanges = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]) => {
		for (const transaction of transactions) {
			if (transaction === undefined) continue
			this.updateTokenChanges(transaction)
		}
	}

	public constructor(transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]) {
		this.summarizeToAddressChanges(transactions)
		// remove addresses that ended up with no changes
		const summaryEntriesArray = Array.from(this.summary.entries())
		for (const [address, addressSummary] of summaryEntriesArray) {
			if (
				addressSummary.erc721TokenBalanceChanges.size === 0 &&
				addressSummary.erc721TokenIdApprovalChanges.size === 0 &&
				addressSummary.erc20TokenApprovalChanges.size === 0 &&
				addressSummary.erc20TokenBalanceChanges.size === 0 &&
				addressSummary.erc1155TokenBalanceChanges.size === 0 &&
				addressSummary.erc721and1155OperatorChanges.size === 0
			) {
				this.summary.delete(address)
			}
		}
	}

	public getSummary = (addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]) => {
		const summaries: SummaryOutcome[] = []
		for (const [address, _summary] of this.summary.entries()) {
			const summary = this.getSummaryForAddr(address, addressMetaData, tokenPriceEstimates, namedTokenIds)
			if (summary === undefined) continue
			const summaryFor = addressMetaData.get(address)
			if (summaryFor === undefined) throw new Error(`Missing metadata for address: ${ address }`)
			summaries.push({ summaryFor: summaryFor, ...summary })
		}
		return summaries
	}

	public readonly getSummaryForAddr = (address: string, addressMetaData: Map<string, AddressBookEntry>, tokenPriceEstimates: readonly TokenPriceEstimate[], namedTokenIds: readonly NamedTokenId[]): Omit<SummaryOutcome, 'summaryFor'> | undefined => {
		const addressSummary = this.summary.get(address)
		if (addressSummary === undefined) return undefined

		const erc20TokenBalanceChanges: Erc20TokenBalanceChange[] = Array.from(addressSummary.erc20TokenBalanceChanges).map(([tokenAddress, changeAmount]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC20') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			const tokenPriceEstimate = tokenPriceEstimates.find((x) => addressString(x.token.address) === tokenAddress)
			const quoteTokenAddress = tokenPriceEstimate?.quoteToken.address
			const tokenPriceEstimateQuoteTokenAddressEntry = quoteTokenAddress === undefined ? undefined : addressMetaData.get(addressString(quoteTokenAddress))
			const tokenPriceEstimateQuoteToken = tokenPriceEstimateQuoteTokenAddressEntry?.type === 'ERC20' ? tokenPriceEstimateQuoteTokenAddressEntry : undefined
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
				approvals: Array.from(approvals).map( ([addressToApprove, change]) => {
					const approvedAddresMetadata = addressMetaData.get(addressToApprove)
					if (approvedAddresMetadata === undefined) throw new Error('Missing metadata for address')
					return { ...approvedAddresMetadata, change }
				}),
			}
		})

		const erc721TokenBalanceChanges: (Erc721Entry & { received: boolean, tokenId: bigint })[] = Array.from(addressSummary.erc721TokenBalanceChanges).map(([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return Array.from(tokenIds).map(([tokenId, received]) => ({
				...metadata,
				tokenId: BigInt(tokenId),
				received,
			}))
		}).reduce((accumulator, value) => accumulator.concat(value), [] as (Erc721Entry & { received: boolean, tokenId: bigint })[])

		const erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[] = Array.from(addressSummary.erc721TokenIdApprovalChanges).map( ([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return Array.from(approvals).map( ([tokenId, approvedAddress]) => {
				const approvedMetadata = addressMetaData.get(approvedAddress)
				if (approvedMetadata === undefined) throw new Error(`Missing metadata for address: ${ approvedAddress }`)
				return {
					tokenEntry: metadata,
					tokenId: BigInt(tokenId),
					approvedEntry: approvedMetadata
				}
			})
		}).reduce((accumulator, value) => accumulator.concat(value), [] as Erc721TokenApprovalChange[])

		const erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[] = Array.from(addressSummary.erc1155TokenBalanceChanges).map(([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC1155') throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			return Array.from(tokenIds).map(([tokenId, changeAmount]) => ({
				...metadata,
				tokenId: BigInt(tokenId),
				tokenIdnName: namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === BigInt(tokenAddress) && namedTokenId.tokenId === BigInt(tokenId))?.tokenIdName,
				changeAmount,
			}))
		}).reduce((accumulator, value) => accumulator.concat(value), [] as Erc1155TokenBalanceChange[])

		const erc721and1155OperatorChanges: Erc721and1155OperatorChange[] = Array.from(addressSummary.erc721and1155OperatorChanges).map(([tokenAddress, operator]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || (metadata.type !== 'ERC1155' && metadata.type !== 'ERC721')) throw new Error(`Missing metadata for token: ${ tokenAddress }`)
			if (operator === undefined) {
				return {
					...metadata,
					operator: undefined,
				}
			}
			const operatorMetadata = addressMetaData.get(operator)
			if (operatorMetadata === undefined) throw new Error(`Missing operator metadata: ${ operator }`)
			return {
				...metadata,
				operator: operatorMetadata,
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
}
