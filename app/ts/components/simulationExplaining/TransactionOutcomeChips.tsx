import type { ComponentChildren } from 'preact'
import { summarizeLogsForAddress, type SummaryOutcome } from '../../simulation/services/LogSummarizer.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../../types/addressBookTypes.js'
import type { NamedTokenId, SimulatedAndVisualizedTransaction, TokenPriceEstimate } from '../../types/visualizer-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { grantsSpendingRights } from '../../utils/approvals.js'
import { isUnlimitedErc20Approval } from '../../utils/erc20.js'
import { AbbreviatedValue } from '../subcomponents/AbbreviatedValue.js'
import { getToneClass, type StatusTone } from '../ui-utils.js'

const MAX_VISIBLE_OUTCOME_CHIPS = 4

type OutcomeChip = {
	key: string
	tone: StatusTone
	content: ComponentChildren
}

type AddressOutcome = Omit<SummaryOutcome, 'summaryFor'>

function TokenLogo({ tokenEntry }: { tokenEntry: Pick<Erc20TokenEntry, 'logoUri'> }) {
	if (tokenEntry.logoUri === undefined) return <></>
	return <img class = 'outcome-chip-logo' src = { tokenEntry.logoUri } alt = '' width = '14' height = '14'/>
}

function SignedAmount({ amount, decimals }: { amount: bigint, decimals: bigint }) {
	return <span>{ amount < 0n ? '−' : '+' }<AbbreviatedValue amount = { abs(amount) } decimals = { decimals }/></span>
}

function getTokenIdLabel(tokenAddress: bigint, tokenId: bigint, namedTokenIds: readonly NamedTokenId[]) {
	const tokenIdName = namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === tokenAddress && namedTokenId.tokenId === tokenId)?.tokenIdName
	if (tokenIdName !== undefined) return tokenIdName
	const tokenIdText = tokenId.toString()
	return `#${ tokenIdText.length > 9 ? `${ tokenIdText.slice(0, 8) }…` : tokenIdText }`
}

export function getAddressOutcomeChips(outcome: AddressOutcome, namedTokenIds: readonly NamedTokenId[]): readonly OutcomeChip[] {
	const balanceChips = outcome.erc20TokenBalanceChanges.map((change): OutcomeChip => ({
		key: `erc20-${ change.address.toString() }`,
		tone: change.changeAmount < 0n ? 'negative' : 'positive',
		content: <><SignedAmount amount = { change.changeAmount } decimals = { change.decimals }/><TokenLogo tokenEntry = { change }/><span>{ change.symbol }</span></>,
	}))
	const erc721Chips = outcome.erc721TokenBalanceChanges.map((change): OutcomeChip => ({
		key: `erc721-${ change.address.toString() }-${ change.tokenId.toString() }`,
		tone: change.received ? 'positive' : 'negative',
		content: <><span>{ change.received ? '+' : '−' }{ getTokenIdLabel(change.address, change.tokenId, namedTokenIds) }</span><TokenLogo tokenEntry = { change }/><span>{ change.symbol }</span></>,
	}))
	const erc1155Chips = outcome.erc1155TokenBalanceChanges.map((change): OutcomeChip => ({
		key: `erc1155-${ change.address.toString() }-${ change.tokenId.toString() }`,
		tone: change.changeAmount < 0n ? 'negative' : 'positive',
		content: <><span>{ change.changeAmount < 0n ? '−' : '+' }{ abs(change.changeAmount).toString() } × { getTokenIdLabel(change.address, change.tokenId, namedTokenIds) }</span><TokenLogo tokenEntry = { change }/><span>{ change.symbol }</span></>,
	}))
	const erc20ApprovalChips = outcome.erc20TokenApprovalChanges.flatMap((token) => token.approvals.map((approval, index): OutcomeChip => {
		const key = `erc20-approval-${ token.address.toString() }-${ approval.address.toString() }-${ index }`
		if (!grantsSpendingRights({ kind: 'erc20Allowance', allowance: approval.change })) return { key, tone: 'positive', content: <><TokenLogo tokenEntry = { token }/><span>{ token.symbol } allowance removed</span></> }
		if (isUnlimitedErc20Approval(approval.change)) return { key, tone: 'warning', content: <><span>Unlimited</span><TokenLogo tokenEntry = { token }/><span>{ token.symbol } allowance</span></> }
		return { key, tone: 'warning', content: <><span>Allow <AbbreviatedValue amount = { approval.change } decimals = { token.decimals }/></span><TokenLogo tokenEntry = { token }/><span>{ token.symbol }</span></> }
	}))
	const operatorChips = outcome.erc721and1155OperatorChanges.map((token, index): OutcomeChip => {
		const key = `operator-${ token.address.toString() }-${ index }`
		// The log summary carries an operator only when the shared approval rule found it was granted.
		if (token.operator === undefined) return { key, tone: 'positive', content: <><TokenLogo tokenEntry = { token }/><span>{ token.symbol } approval removed</span></> }
		return { key, tone: 'warning', content: <><span>All</span><TokenLogo tokenEntry = { token }/><span>{ token.symbol } approved</span></> }
	})
	const tokenIdApprovalChips = outcome.erc721TokenIdApprovalChanges.map((approval): OutcomeChip => {
		const granted = grantsSpendingRights({ kind: 'tokenId', approvedAddress: approval.approvedEntry.address })
		return {
			key: `erc721-approval-${ approval.tokenEntry.address.toString() }-${ approval.tokenId.toString() }`,
			tone: granted ? 'warning' : 'positive',
			content: <><span>{ getTokenIdLabel(approval.tokenEntry.address, approval.tokenId, namedTokenIds) }</span><TokenLogo tokenEntry = { approval.tokenEntry }/><span>{ approval.tokenEntry.symbol } { granted ? 'approved' : 'approval removed' }</span></>,
		}
	})
	const chips = [...balanceChips, ...erc721Chips, ...erc1155Chips, ...erc20ApprovalChips, ...operatorChips, ...tokenIdApprovalChips]
	// Newly granted approvals come first so they are never the chips hidden behind "+N more".
	return [...chips.filter((chip) => chip.tone === 'warning'), ...chips.filter((chip) => chip.tone !== 'warning')]
}

type TransactionOutcomeChipsParams = {
	simTx: SimulatedAndVisualizedTransaction
	activeAddress: bigint | undefined
	addressMetaData: readonly AddressBookEntry[]
	tokenPriceEstimates: readonly TokenPriceEstimate[]
	namedTokenIds: readonly NamedTokenId[]
}

// Summarises what one transaction does to the active account, so a stack row can be read without opening it.
export function TransactionOutcomeChips({ simTx, activeAddress, addressMetaData, tokenPriceEstimates, namedTokenIds }: TransactionOutcomeChipsParams) {
	if (simTx.transactionStatus !== 'Transaction Succeeded') return <ul class = 'outcome-chips' aria-label = 'Transaction result'>
		<li class = { `outcome-chip ${ getToneClass('outcome-chip', 'negative') }` }>Transaction fails</li>
	</ul>
	if (activeAddress === undefined) return <></>
	const addressMetaDataMap = new Map(addressMetaData.map((entry) => [addressString(entry.address), entry]))
	const outcome = summarizeLogsForAddress([simTx], addressString(activeAddress), addressMetaDataMap, tokenPriceEstimates, namedTokenIds)
	const chips = outcome === undefined ? [] : getAddressOutcomeChips(outcome, namedTokenIds)
	if (chips.length === 0) return <ul class = 'outcome-chips' aria-label = 'Changes to your account'>
		<li class = { `outcome-chip ${ getToneClass('outcome-chip', 'neutral') }` }>No changes to your account</li>
	</ul>
	const visibleChips = chips.slice(0, MAX_VISIBLE_OUTCOME_CHIPS)
	const hiddenChipCount = chips.length - visibleChips.length
	return <ul class = 'outcome-chips' aria-label = 'Changes to your account'>
		{ visibleChips.map((chip) => <li key = { chip.key } class = { `outcome-chip ${ getToneClass('outcome-chip', chip.tone) }` }>{ chip.content }</li>) }
		{ hiddenChipCount === 0 ? <></> : <li class = { `outcome-chip ${ getToneClass('outcome-chip', 'neutral') }` }>+{ hiddenChipCount } more</li> }
	</ul>
}
