import { addressString } from '../../utils/bigint.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import { Erc721TokenApprovalChange, Erc721Definition, SimulatedAndVisualizedTransaction, ERC20TokenApprovalChange, Erc20TokenBalanceChange, TokenPriceEstimate, TokenVisualizerResultWithMetadata, Erc1155Definition } from '../../utils/visualizer-types.js'

export type BalanceChangeSummary = {
	erc20TokenBalanceChanges: Map<string, bigint>, // token address, amount
	erc20TokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount

	erc721TokenBalanceChanges: Map<string, Map<string, boolean > >, // token address, token id, {true if received, false if sent}
	erc721OperatorChanges: Map<string, string | undefined> // token address, operator
	erc721TokenIdApprovalChanges: Map<string, Map<string, string > > // token address, tokenId, approved address

	erc1155TokenBalanceChanges: Map<string, Map<string, bigint > >, // token address, token id, { amount }
	erc1155OperatorChanges: Map<string, string | undefined> // token address, operator

	etherResults: {
		balanceBefore: bigint,
		balanceAfter: bigint,
	} | undefined
}

export type Erc1155TokenBalanceChange = (Erc1155Definition & { changeAmount: bigint })

export type SummaryOutcome = {
	summaryFor: AddressBookEntry
	erc20TokenBalanceChanges: Erc20TokenBalanceChange[]
	erc20TokenApprovalChanges: ERC20TokenApprovalChange[]

	erc721TokenBalanceChanges: (Erc721Definition & { received: boolean })[]
	erc721OperatorChanges: (Omit<Erc721Definition, 'tokenId'> & { operator: AddressBookEntry | undefined })[]
	erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[]
	
	erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[]
	erc1155OperatorChanges: (Omit<Erc1155Definition, 'tokenId'> & { operator: AddressBookEntry | undefined })[]

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
				erc721TokenBalanceChanges: new Map(),
				erc721OperatorChanges: new Map(),
				erc721TokenIdApprovalChanges: new Map(),

				erc1155TokenBalanceChanges: new Map(),
				erc1155OperatorChanges: new Map(),

				erc20TokenApprovalChanges: new Map(),
				erc20TokenBalanceChanges: new Map(),
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

	private updateErc721 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC721' && change.type !== 'NFT All approval') return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if (change.type === 'NFT All approval') {
				if (change.allApprovalAdded) {
					fromSummary.erc721OperatorChanges.set(tokenAddress, to)
				} else {
					fromSummary.erc721OperatorChanges.set(tokenAddress, undefined)
				}
				return
			}
			if(!fromSummary.erc721TokenIdApprovalChanges.has(tokenAddress)) {
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

	private updateErc1155 = (from: string, to: string, tokenAddress: string, change: TokenVisualizerResultWithMetadata) => {
		if (change.type !== 'ERC1155' && change.type !== 'NFT All approval') return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if (change.type === 'NFT All approval') {
				if (change.allApprovalAdded) {
					fromSummary.erc1155OperatorChanges.set(tokenAddress, to)
				} else {
					fromSummary.erc1155OperatorChanges.set(tokenAddress, undefined)
				}
				return
			}
		} else {
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
		for (const change of result.tokenResults) {
			const from = addressString(change.from.address)
			const to = addressString(change.to.address)
			const tokenAddress = addressString(change.token.address)

			for (const address of [from, to]) {
				this.ensureAddressInSummary(address)
			}

			this.updateErc1155(from, to, tokenAddress, change)
			this.updateErc721(from, to, tokenAddress, change)
			this.updateErc20(from, to, tokenAddress, change)
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
				&& addressSummary.erc721OperatorChanges.size === 0
				&& addressSummary.erc721TokenBalanceChanges.size === 0
				&& addressSummary.erc721TokenIdApprovalChanges.size === 0
				&& addressSummary.erc20TokenApprovalChanges.size === 0
				&& addressSummary.erc20TokenBalanceChanges.size === 0
				&& addressSummary.erc1155TokenBalanceChanges.size === 0
				&& addressSummary.erc1155OperatorChanges.size === 0
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
		console.log('getSummary')
		console.log(summaries)
		return summaries
	}

	public readonly getSummaryForAddr = (address: string, addressMetaData: Map<string, AddressBookEntry>, tokenPrices: readonly TokenPriceEstimate[]): Omit<SummaryOutcome, 'summaryFor'> | undefined => {
		const addressSummary = this.summary.get(address)
		if (addressSummary === undefined) return undefined

		const erc20TokenBalanceChanges: Erc20TokenBalanceChange[] = Array.from(addressSummary.erc20TokenBalanceChanges).map(([tokenAddress, changeAmount]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC20') throw new Error('Missing metadata for token')
			return {
				...metadata,
				changeAmount: changeAmount,
				tokenPriceEstimate: tokenPrices.find((x) => addressString(x.token.address) === tokenAddress)
			}
		})

		const erc20TokenApprovalChanges: ERC20TokenApprovalChange[] = Array.from(addressSummary.erc20TokenApprovalChanges).map( ([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC20') throw new Error('Missing metadata for token')
			return {
				...metadata,
				approvals: Array.from(approvals).map( ([addressToApprove, change]) => {
					const approvedAddresMetadata = addressMetaData.get(addressToApprove)
					if (approvedAddresMetadata === undefined) throw new Error('Missing metadata for address')
					return { ...approvedAddresMetadata, change }
				}),
			}
		})

		const erc721TokenBalanceChanges: (Erc721Definition & { received: boolean })[] = Array.from(addressSummary.erc721TokenBalanceChanges).map( ([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error('Missing metadata for token')
			return Array.from(tokenIds).map(([tokenId, received]) => ({
				...metadata,
				tokenId: BigInt(tokenId),
				received,
			}))
		}).reduce((accumulator, value) => accumulator.concat(value), [])

		const erc721OperatorChanges: (Omit<Erc721Definition, 'tokenId'> & { operator: AddressBookEntry | undefined })[] = Array.from(addressSummary.erc721OperatorChanges).map( ([tokenAddress, operator]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error('Missing metadata for token')

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

		const erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[] = Array.from(addressSummary.erc721TokenIdApprovalChanges).map( ([tokenAddress, approvals]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC721') throw new Error('Missing metadata for token')
			return Array.from(approvals).map( ([tokenId, approvedAddress]) => {
				const approvedMetadata = addressMetaData.get(approvedAddress)
				if (approvedMetadata === undefined) throw new Error('Missing metadata for token')
				return {
					token: {
						...metadata,
						tokenId: BigInt(tokenId),
					},
					approvedEntry: approvedMetadata
				}
			})
		}).reduce((accumulator, value) => accumulator.concat(value), [])

		const erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[] = Array.from(addressSummary.erc1155TokenBalanceChanges).map(([tokenAddress, tokenIds]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC1155') throw new Error('Missing metadata for token')
			return Array.from(tokenIds).map(([tokenId, changeAmount]) => ({
				...metadata,
				tokenId: BigInt(tokenId),
				changeAmount,
			}))
		}).reduce((accumulator, value) => accumulator.concat(value), [])

		const erc1155OperatorChanges: (Omit<Omit<Erc1155Definition, 'tokenId'>, 'amount'> & { operator: AddressBookEntry | undefined })[] = Array.from(addressSummary.erc721OperatorChanges).map(([tokenAddress, operator]) => {
			const metadata = addressMetaData.get(tokenAddress)
			if (metadata === undefined || metadata.type !== 'ERC1155') throw new Error('Missing metadata for token')

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

		return {
			erc20TokenBalanceChanges,
			erc20TokenApprovalChanges,
			erc721TokenBalanceChanges,
			erc721OperatorChanges,
			erc721TokenIdApprovalChanges,
			erc1155TokenBalanceChanges,
			erc1155OperatorChanges,
			etherResults: addressSummary.etherResults
		}
	}
}
