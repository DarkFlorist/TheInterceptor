import type { TokenVisualizerResultWithMetadata } from '../types/EnrichedEthereumData.js'

// The ways an approval can change, reduced to what decides whether spending rights are handed out or taken away.
export type ApprovalChange =
	| { kind: 'erc20Allowance', allowance: bigint }
	| { kind: 'operator', operatorApproved: boolean }
	| { kind: 'tokenId' }

// The rule for whether an approval grants spending rights. The confirmation checks, the transaction title, the token event rows, the stack row chips and the account summary all decide through it, so they cannot disagree about the same transaction. The log summary stores an operator only when this rule says it was granted.
export function grantsSpendingRights(change: ApprovalChange) {
	switch (change.kind) {
		case 'erc20Allowance': return change.allowance > 0n
		case 'operator': return change.operatorApproved
		case 'tokenId': return true
	}
}

// Describes the approval a simulated token event makes; transfers make none.
export function getApprovalChangeOfTokenEvent(tokenEvent: TokenVisualizerResultWithMetadata): ApprovalChange | undefined {
	if (!tokenEvent.isApproval) return undefined
	switch (tokenEvent.type) {
		case 'ERC20': return { kind: 'erc20Allowance', allowance: tokenEvent.amount }
		case 'NFT All approval': return { kind: 'operator', operatorApproved: tokenEvent.allApprovalAdded }
		case 'ERC721': return { kind: 'tokenId' }
	}
}

// True when the token event is an approval that grants spending rights; false for transfers and for approvals that remove rights.
export function tokenEventGrantsSpendingRights(tokenEvent: TokenVisualizerResultWithMetadata) {
	const approvalChange = getApprovalChangeOfTokenEvent(tokenEvent)
	return approvalChange !== undefined && grantsSpendingRights(approvalChange)
}
