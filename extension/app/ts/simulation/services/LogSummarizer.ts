
import { addressString } from '../../utils/bigint.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import { ERC721TokenApprovalChange, ERC721TokenDefinitionParams, SimulatedAndVisualizedTransaction, TokenApprovalChange, TokenBalanceChange, TokenPriceEstimate, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'

export type BalanceChangeSummary = {
	ERC721TokenBalanceChanges: Map<string, Map<string, boolean > >, // token address, token id, {true if received, false if sent}
	ERC721OperatorChanges: Map<string, string | undefined> // token address, operator
	ERC721TokenIdApprovalChanges: Map<string, Map<string, string > > // token address, tokenId, approved address

	tokenBalanceChanges: Map<string, bigint>, // token address, amount
	tokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount
	etherResults: {
		balanceBefore: bigint,
		balanceAfter: bigint,
	} | undefined
}

export type SummaryOutcome = {
	summaryFor: AddressBookEntry
	tokenBalanceChanges: TokenBalanceChange[]
	tokenApprovalChanges: TokenApprovalChange[]
	erc721TokenBalanceChanges: (ERC721TokenDefinitionParams & { received: boolean })[]
	erc721OperatorChanges: (Omit<ERC721TokenDefinitionParams, 'id'> & { operator: AddressBookEntry | undefined })[]
	erc721TokenIdApprovalChanges: ERC721TokenApprovalChange[]
	etherResults: {
		balanceBefore: bigint,
		balanceAfter: bigint,
	} | undefined
}

export class LogSummarizer {
	private summary = new Map<string, BalanceChangeSummary>()

	private ensureAddressInSummary = (address: string) => {
		if ( !this.summary.has(address)) {
			this.summary.set(address, {
				ERC721TokenBalanceChanges: new Map(),
				ERC721OperatorChanges: new Map(),
				ERC721TokenIdApprovalChanges: new Map(),
				tokenApprovalChanges: new Map(),
				tokenBalanceChanges: new Map(),
				etherResults: undefined
			})
		}
	}

	private updateEthBalances = (result: SimulatedAndVisualizedTransaction) => {
		for (const change of result.ethBalanceChanges) {
			const address = addressString(change.address.address)
			this.ensureAddressInSummary(address)
			const addressData = this.summary.get(address)!
			const etherResults = this.summary.get(address)?.etherResults
			if ( etherResults !== undefined ) {
				addressData.etherResults!.balanceAfter = change.after
			} else {
				const { etherResults, ...values } = addressData
				this.summary.set(address, {
					...values,
					etherResults: {
						balanceBefore: change.before,
						balanceAfter: change.after
					}
				})
			}

			// on no change, keep change undefined
			if (addressData.etherResults?.balanceAfter === addressData.etherResults?.balanceBefore) {
				addressData.etherResults = undefined
			}
		}
	}

	private updateERC721 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type === 'Token') return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if (change.type === 'NFT All approval') {
				if (change.allApprovalAdded) {
					fromSummary.ERC721OperatorChanges.set(tokenAddress, to)
				} else {
					fromSummary.ERC721OperatorChanges.set(tokenAddress, undefined)
				}
				return
			}
			if(!fromSummary.ERC721TokenIdApprovalChanges.has(tokenAddress)) {
				fromSummary.ERC721TokenIdApprovalChanges.set(tokenAddress, new Map())
			}
			const thisToken = fromSummary.ERC721TokenIdApprovalChanges.get(tokenAddress)!
			thisToken.set(change.tokenId.toString(), to)
		} else {
			const tokenId = change.tokenId.toString()
			// track balance changes
			for (const val of [ { addr: from, received: false }, { addr: to, received: true } ]) {
				const addrSummary = this.summary.get(val.addr)!
				if (!addrSummary.ERC721TokenBalanceChanges.has(tokenAddress)) {
					addrSummary.ERC721TokenBalanceChanges.set(tokenAddress, new Map())
				}
				const token = addrSummary.ERC721TokenBalanceChanges.get(tokenAddress)!
				if ( token.get(tokenId) === !val.received) { // if we have received and sent, we can clear the entry as there's no change to state
					token.delete(tokenId)
				} else {
					addrSummary.ERC721TokenBalanceChanges.get(tokenAddress)?.set(tokenId, val.received)
				}
				// clear added approvals if any on transfer
				if (!val.received) {
					const approvalChanges = this.summary.get(val.addr)?.ERC721TokenIdApprovalChanges.get(tokenAddress)
					if(approvalChanges) {
						approvalChanges.delete(tokenId)
					}
				}
			}
		}
	}

	private updateERC20 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'Token') return
		if (change.isApproval) {
			// track approvals
			const tokenChanges = this.summary.get(from)!.tokenApprovalChanges.get(tokenAddress)
			if (tokenChanges === undefined) {
				this.summary.get(from)!.tokenApprovalChanges.set(tokenAddress, new Map([[to, change.amount]]))
			} else {
				tokenChanges.set(to, change.amount)
			}
			// TODO: add tracking on how transfers modify the approval number (this requires changes in visualizer results)
		} else {
			// track balance changes
			const oldFromData = this.summary.get(from)!.tokenBalanceChanges.get(tokenAddress)
			this.summary.get(from)!.tokenBalanceChanges.set(tokenAddress, oldFromData === undefined ? -change.amount : oldFromData - change.amount)
			const oldToData = this.summary.get(to)!.tokenBalanceChanges.get(tokenAddress)
			this.summary.get(to)!.tokenBalanceChanges.set(tokenAddress, oldToData === undefined ? change.amount : oldToData + change.amount)

			// clean if change is now zero
			if (this.summary.get(to)!.tokenBalanceChanges.get(tokenAddress) === 0n) {
				this.summary.get(to)!.tokenBalanceChanges.delete(tokenAddress)
			}
			// clean if change is now zero
			if (this.summary.get(from)!.tokenBalanceChanges.get(tokenAddress) === 0n) {
				this.summary.get(from)!.tokenBalanceChanges.delete(tokenAddress)
			}
		}
	}

	private updateTokenChanges = (result: SimulatedAndVisualizedTransaction) => {
		for (const change of result.tokenResults) {
			const from = addressString(change.from.address)
			const to = addressString(change.to.address)
			const tokenAddress = addressString(change.token.address)

			for (const address of [from, to]) {
				this.ensureAddressInSummary(address)
			}

			this.updateERC721(from, to, tokenAddress, change)
			this.updateERC20(from, to, tokenAddress, change)
		}
	}

	private summarizeToAddressChanges = (transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]) => {
		for (const transaction of transactions) {
			if ( transaction === undefined ) continue
			// calculate ether balances for each account
			this.updateEthBalances(transaction)
			// calculate token changes for each account
			this.updateTokenChanges(transaction)
		}
	}

	public constructor(transactions: readonly (SimulatedAndVisualizedTransaction | undefined)[]) {
		this.summarizeToAddressChanges(transactions)

		// remove addresses that ended up with no changes
		Array.from(this.summary.entries()).forEach( ([address, addressSummary]) => {
			if (addressSummary.etherResults === undefined
				&& addressSummary.ERC721OperatorChanges.size === 0
				&& addressSummary.ERC721TokenBalanceChanges.size === 0
				&& addressSummary.ERC721OperatorChanges.size === 0
				&& addressSummary.ERC721TokenIdApprovalChanges.size === 0
				&& addressSummary.tokenApprovalChanges.size === 0
				&& addressSummary.tokenBalanceChanges.size === 0
			) {
				this.summary.delete(address)
			}
		})
	}

	public getSummary = (addressMetaData: Map<string, AddressBookEntry>, tokenPrices: readonly TokenPriceEstimate[] ) => {
		const summaries: SummaryOutcome[] = []
		for (const [address, _summary] of this.summary.entries()) {
			const summary = this.getSummaryForAddr(address, addressMetaData, tokenPrices)
			if (summary === undefined) continue
			const summaryFor = addressMetaData.get(address)
			if (summaryFor === undefined) throw new Error('Missing metadata')
			summaries.push({ summaryFor: summaryFor, ...summary })
		}
		return summaries
	}

	public readonly getSummaryForAddr = (address: string, addressMetaData: Map<string, AddressBookEntry>, tokenPrices: readonly TokenPriceEstimate[] ) => {
		const addressSummary = this.summary.get(address)
		if (addressSummary === undefined) return undefined

		const tokenBalanceChanges: TokenBalanceChange[] = Array.from(addressSummary.tokenBalanceChanges).map(([tokenAddress, changeAmount]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'token') throw new Error('Missing metadata for token')
			return {
				...metadata,
				changeAmount: changeAmount,
				tokenPriceEstimate: tokenPrices.find((x) => x.token === tokenAddress)
			}
		})

		const tokenApprovalChanges: TokenApprovalChange[] = Array.from(addressSummary.tokenApprovalChanges).map( ([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'token') throw new Error('Missing metadata for token')
			return {
				...metadata,
				approvals: Array.from(approvals).map( ([addressToApprove, change]) => {
					const approvedAddresMetadata = addressMetaData.get(addressToApprove)
					if (approvedAddresMetadata === undefined) throw new Error('Missing metadata for address')
					return { ...approvedAddresMetadata, change }
				}),
			}
		})

		const erc721TokenBalanceChanges: (ERC721TokenDefinitionParams & { received: boolean })[] = Array.from(addressSummary.ERC721TokenBalanceChanges).map( ([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'NFT') throw new Error('Missing metadata for token')
			return Array.from(tokenIds).map(([tokenId, received]) => ({
				...metadata,
				id: BigInt(tokenId),
				received,
			}))
		}).reduce((accumulator, value) => accumulator.concat(value), [])

		const erc721OperatorChanges: (Omit<ERC721TokenDefinitionParams, 'id'> & { operator: AddressBookEntry | undefined })[] = Array.from(addressSummary.ERC721OperatorChanges).map( ([tokenAddress, operator]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'NFT') throw new Error('Missing metadata for token')

			if (operator === undefined) {
				return {
					...metadata,
					operator: undefined,
				}
			}
			const operatorMetadata = addressMetaData.get(operator)
			if (operatorMetadata === undefined) throw new Error('Missing metadata for token')
			return {
				...metadata,
				operator: operatorMetadata,
			}
		})

		const erc721TokenIdApprovalChanges: ERC721TokenApprovalChange[] = Array.from(addressSummary.ERC721TokenIdApprovalChanges).map( ([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'NFT') throw new Error('Missing metadata for token')
			return Array.from(approvals).map( ([tokenId, approvedAddress]) => {
				const approvedMetadata = addressMetaData.get(approvedAddress)
				if (approvedMetadata === undefined) throw new Error('Missing metadata for token')
				return {
					token: {
						...metadata,
						id: BigInt(tokenId),
					},
					approvedEntry: approvedMetadata
				}
			})
		}).reduce((accumulator, value) => accumulator.concat(value), [])

		return {
			tokenBalanceChanges,
			tokenApprovalChanges,
			erc721TokenBalanceChanges,
			erc721OperatorChanges,
			erc721TokenIdApprovalChanges,
			etherResults: addressSummary.etherResults
		}
	}
}
