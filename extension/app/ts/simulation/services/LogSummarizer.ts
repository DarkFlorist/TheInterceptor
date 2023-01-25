
import { addressString } from '../../utils/bigint.js'
import { BalanceChangeSummary, SimulatedAndVisualizedTransaction, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'

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
		if ( !change.is721 ) return
		if (change.isApproval) {
			const fromSummary = this.summary.get(from)!
			if ( 'isAllApproval' in change ) {
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
		if ( change.is721 ) return
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

	private summarizeToAddressChanges = (transactions: (SimulatedAndVisualizedTransaction | undefined)[]) => {
		for (const transaction of transactions) {
			if ( transaction === undefined ) continue
			// calculate ether balances for each account
			this.updateEthBalances(transaction)
			// calculate token changes for each account
			this.updateTokenChanges(transaction)
		}
	}

	public constructor(transactions: (SimulatedAndVisualizedTransaction | undefined)[]) {
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

	public readonly getSummary = () => this.summary
}
