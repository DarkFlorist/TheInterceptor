import { extractTokenEvents } from '../../background/metadataUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import type { SimulatedAndVisualizedTransaction } from '../../types/visualizer-types.js'
import { CheckMarkIcon, WarningSignIcon, XMarkIcon } from '../subcomponents/icons.js'

type TransactionCheckTone = 'positive' | 'neutral' | 'warning' | 'negative'

export type TransactionCheck = {
	tone: TransactionCheckTone
	text: string
}

function getDestinationCheck(destination: AddressBookEntry | undefined): TransactionCheck {
	if (destination === undefined) return { tone: 'neutral', text: 'Deploys a new contract' }
	switch (destination.entrySource) {
		case 'User': return { tone: 'positive', text: `Sent to ${ destination.name }, which is in your address book` }
		case 'DarkFloristMetadata':
		case 'Interceptor': return { tone: 'positive', text: `Sent to ${ destination.name }, a known address` }
		case 'OnChain': return { tone: 'warning', text: `Sent to ${ destination.name }, whose name is self-reported and unverified` }
		case 'FilledIn': return { tone: 'neutral', text: 'Sent to an address that is not in your address book' }
	}
}

// An approval event grants spending rights unless it sets an ERC20 allowance to zero or removes an operator.
function grantsApproval(approval: TokenVisualizerResultWithMetadata) {
	if (approval.type === 'ERC20') return approval.amount > 0n
	if (approval.type === 'NFT All approval') return approval.allApprovalAdded
	return true
}

function getApprovalCheck(approvals: readonly TokenVisualizerResultWithMetadata[]): TransactionCheck {
	if (approvals.length === 0) return { tone: 'positive', text: 'No token approvals are changed' }
	const grantedCount = approvals.filter(grantsApproval).length
	if (grantedCount === 0) return { tone: 'positive', text: approvals.length === 1 ? 'Only removes a token approval' : 'Only removes token approvals' }
	return { tone: 'warning', text: grantedCount === 1 ? 'Grants one token approval' : `Grants ${ grantedCount } token approvals` }
}

// Plain-language facts about a simulated transaction, derived only from its simulation result, shown before the raw details.
export function getTransactionChecks(simTx: SimulatedAndVisualizedTransaction): readonly TransactionCheck[] {
	const statusCheck: TransactionCheck = simTx.transactionStatus === 'Transaction Succeeded'
		? { tone: 'positive', text: 'The simulation succeeded' }
		: { tone: 'negative', text: 'The transaction fails in the simulation' }
	const destinationCheck = getDestinationCheck(simTx.transaction.to)
	if (simTx.transactionStatus !== 'Transaction Succeeded') return [statusCheck, destinationCheck]
	const approvalCheck = getApprovalCheck(extractTokenEvents(simTx.events).filter((tokenEvent) => tokenEvent.isApproval))
	const flaggedCount = simTx.quarantineReasons.length
	const flaggedChecks: readonly TransactionCheck[] = flaggedCount === 0 ? [] : [{ tone: 'negative', text: flaggedCount === 1 ? 'The Interceptor flagged one issue' : `The Interceptor flagged ${ flaggedCount } issues` }]
	return [statusCheck, destinationCheck, approvalCheck, ...flaggedChecks]
}

function TransactionCheckIcon({ tone }: { tone: TransactionCheckTone }) {
	switch (tone) {
		case 'positive': return <CheckMarkIcon/>
		case 'neutral': return <span class = 'transaction-check-dot'/>
		case 'warning': return <WarningSignIcon/>
		case 'negative': return <XMarkIcon/>
	}
}

export function TransactionChecks({ simTx }: { simTx: SimulatedAndVisualizedTransaction }) {
	return <ul class = 'transaction-checks' aria-label = 'Transaction checks'>
		{ getTransactionChecks(simTx).map((check) => <li key = { check.text } class = { `transaction-check transaction-check--${ check.tone }` }>
			<span class = 'transaction-check-icon'><TransactionCheckIcon tone = { check.tone }/></span>
			<span class = 'transaction-check-text'>{ check.text }</span>
		</li>) }
	</ul>
}
