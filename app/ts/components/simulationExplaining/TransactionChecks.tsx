import { extractTokenEvents } from '../../background/metadataUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import type { SimulatedAndVisualizedTransaction } from '../../types/visualizer-types.js'
import { tokenEventGrantsSpendingRights } from '../../utils/approvals.js'
import { CheckMarkIcon, WarningSignIcon, XMarkIcon } from '../subcomponents/icons.js'
import { getToneClass, type StatusTone } from '../ui-utils.js'
import { getAddressTrust, getTransactionVerdict } from '../../utils/simulationVerdict.js'

export type TransactionCheck = {
	tone: StatusTone
	text: string
}

function getDestinationCheck(destination: AddressBookEntry | undefined): TransactionCheck {
	if (destination === undefined) return { tone: 'neutral', text: 'Deploys a new contract' }
	switch (getAddressTrust(destination)) {
		case 'addressBook': return { tone: 'positive', text: `Sent to ${ destination.name }, which is in your address book` }
		case 'known': return { tone: 'positive', text: `Sent to ${ destination.name }, a known address` }
		case 'selfReported': return { tone: 'warning', text: `Sent to ${ destination.name }, whose name is self-reported and unverified` }
		case 'unknown': return { tone: 'neutral', text: 'Sent to an address that is not in your address book' }
	}
}

function getFlaggedCheckText(flaggedReasonCount: number) {
	if (flaggedReasonCount === 0) return 'The Interceptor flagged this transaction'
	return flaggedReasonCount === 1 ? 'The Interceptor flagged one issue' : `The Interceptor flagged ${ flaggedReasonCount } issues`
}

function getApprovalCheck(approvals: readonly TokenVisualizerResultWithMetadata[]): TransactionCheck {
	if (approvals.length === 0) return { tone: 'positive', text: 'No token approvals are changed' }
	const grantedCount = approvals.filter(tokenEventGrantsSpendingRights).length
	if (grantedCount === 0) return { tone: 'positive', text: approvals.length === 1 ? 'Only removes a token approval' : 'Only removes token approvals' }
	return { tone: 'warning', text: grantedCount === 1 ? 'Grants one token approval' : `Grants ${ grantedCount } token approvals` }
}

// Plain-language facts about a simulated transaction, derived only from its simulation result, shown before the raw details.
export function getTransactionChecks(simTx: SimulatedAndVisualizedTransaction): readonly TransactionCheck[] {
	const verdict = getTransactionVerdict(simTx)
	const destinationCheck = getDestinationCheck(simTx.transaction.to)
	if (verdict === 'failed') return [{ tone: 'negative', text: 'The transaction fails in the simulation' }, destinationCheck]
	const statusCheck: TransactionCheck = { tone: 'positive', text: 'The simulation succeeded' }
	const approvalCheck = getApprovalCheck(extractTokenEvents(simTx.events).filter((tokenEvent) => tokenEvent.isApproval))
	// The flagged check appears exactly when the shared verdict says the transaction is flagged, so it always matches the stack row and the confirmation buttons.
	const flaggedChecks: readonly TransactionCheck[] = verdict === 'flagged' ? [{ tone: 'negative', text: getFlaggedCheckText(simTx.quarantineReasons.length) }] : []
	return [statusCheck, destinationCheck, approvalCheck, ...flaggedChecks]
}

function TransactionCheckIcon({ tone }: { tone: StatusTone }) {
	switch (tone) {
		case 'positive': return <CheckMarkIcon/>
		case 'neutral': return <span class = 'transaction-check-dot'/>
		case 'warning': return <WarningSignIcon/>
		case 'negative': return <XMarkIcon/>
	}
}

export function TransactionChecks({ simTx }: { simTx: SimulatedAndVisualizedTransaction }) {
	return <ul class = 'transaction-checks' aria-label = 'Transaction checks'>
		{ getTransactionChecks(simTx).map((check) => <li key = { check.text } class = { `transaction-check ${ getToneClass('transaction-check', check.tone) }` }>
			<span class = 'transaction-check-icon'><TransactionCheckIcon tone = { check.tone }/></span>
			<span class = 'transaction-check-text'>{ check.text }</span>
		</li>) }
	</ul>
}
