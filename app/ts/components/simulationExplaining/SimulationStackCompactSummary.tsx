import type { ReadonlySignal } from '@preact/signals'
import { identifySignature } from './identifySignature.js'
import { identifyTransaction } from './identifyTransaction.js'
import { normalizeSimulationStackRows, type SimulationStackMessageRow, type SimulationStackTransactionRow } from './simulationStackRows.js'
import type { CompleteVisualizedSimulation, ResolvedSimulationResults, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'

export type SimulationStackNameRow = {
	key: string
	title: string
	status: 'pending' | 'simulated' | 'failed'
	kind: 'transaction' | 'message' | 'rich-addresses'
}

function richAddressRow(numberOfAddressesMadeRich: number): SimulationStackNameRow | undefined {
	if (numberOfAddressesMadeRich === 0) return undefined
	return {
		key: 'rich-addresses',
		title: `Simply making ${ numberOfAddressesMadeRich } ${ numberOfAddressesMadeRich === 1 ? 'address' : 'addresses' } rich`,
		status: 'simulated',
		kind: 'rich-addresses',
	}
}

function pendingTransactionTitle(row: SimulationStackTransactionRow) {
	if (row.preSimulationTransaction.originalRequestParameters.method === 'eth_sendRawTransaction') return 'Pending raw transaction'
	return 'Pending transaction'
}

function getTransactionRowTitle(row: SimulationStackTransactionRow) {
	if (row.simulatedTransaction === undefined) return pendingTransactionTitle(row)
	return identifyTransaction(row.simulatedTransaction).title
}

function transactionNameRow(row: SimulationStackTransactionRow): SimulationStackNameRow {
	return {
		key: `transaction-${ row.preSimulationTransaction.transactionIdentifier.toString() }`,
		title: getTransactionRowTitle(row),
		status: row.status,
		kind: 'transaction',
	}
}

function getMessageRowTitle(row: SimulationStackMessageRow) {
	if (row.visualizedPersonalSignRequest === undefined) return 'Pending signature'
	return identifySignature(row.visualizedPersonalSignRequest).title
}

function messageNameRow(row: SimulationStackMessageRow): SimulationStackNameRow {
	return {
		key: `message-${ row.signedMessageTransaction.messageIdentifier.toString() }`,
		title: getMessageRowTitle(row),
		status: row.status,
		kind: 'message',
	}
}

export function getSimulationStackNameRowsFromResults(simulationAndVisualisationResults: SimulationAndVisualisationResults | undefined, numberOfAddressesMadeRich: number): readonly SimulationStackNameRow[] {
	const firstRow = richAddressRow(numberOfAddressesMadeRich)
	if (simulationAndVisualisationResults === undefined) return firstRow === undefined ? [] : [firstRow]
	const blocks = normalizeSimulationStackRows(
		simulationAndVisualisationResults.simulationStateInput,
		simulationAndVisualisationResults.visualizedSimulationState,
	)
	const rows = blocks.flatMap((block) => block.rows.map((row) => row.type === 'Message' ? messageNameRow(row) : transactionNameRow(row)))
	return firstRow === undefined ? rows : [firstRow, ...rows]
}

export function getSimulationStackNameRows(completeVisualizedSimulation: CompleteVisualizedSimulation): readonly SimulationStackNameRow[] {
	if (completeVisualizedSimulation.simulationState.kind === 'passthrough') {
		return getSimulationStackNameRowsFromResults(undefined, completeVisualizedSimulation.numberOfAddressesMadeRich)
	}
	return getSimulationStackNameRowsFromResults({
		blockNumber: completeVisualizedSimulation.simulationState.value.blockNumber,
		blockTimestamp: completeVisualizedSimulation.simulationState.value.blockTimestamp,
		simulationConductedTimestamp: completeVisualizedSimulation.simulationState.value.simulationConductedTimestamp,
		simulationStateInput: completeVisualizedSimulation.simulationState.value.simulationStateInput,
		addressBookEntries: completeVisualizedSimulation.addressBookEntries,
		visualizedSimulationState: completeVisualizedSimulation.visualizedSimulationState,
		rpcNetwork: completeVisualizedSimulation.simulationState.value.rpcNetwork,
		tokenPriceEstimates: completeVisualizedSimulation.tokenPriceEstimates,
		namedTokenIds: completeVisualizedSimulation.namedTokenIds,
	}, completeVisualizedSimulation.numberOfAddressesMadeRich)
}

function getStatusIcon(row: SimulationStackNameRow) {
	switch (row.status) {
		case 'pending': return '../img/question-mark-sign.svg'
		case 'failed': return '../img/error-icon.svg'
		case 'simulated': return '../img/success-icon.svg'
	}
}

type SimulationStackCompactSummaryProps = {
	simulationAndVisualisationResults: ReadonlySignal<ResolvedSimulationResults>
	numberOfAddressesMadeRich: ReadonlySignal<number>
}

export function SimulationStackCompactSummary({ simulationAndVisualisationResults, numberOfAddressesMadeRich }: SimulationStackCompactSummaryProps) {
	const currentResults = simulationAndVisualisationResults.value
	const rows = getSimulationStackNameRowsFromResults(
		currentResults.kind === 'passthrough' ? undefined : currentResults.value,
		numberOfAddressesMadeRich.value,
	)
	if (rows.length === 0) return <></>
	return <section class = 'card' style = 'background-color: var(--card-bg-color); margin: 10px;'>
		<header class = 'card-header'>
			<div class = 'card-header-title'>
				<p class = 'paragraph'>Stack</p>
			</div>
		</header>
		<div class = 'card-content' style = 'padding: 0.75rem;'>
			<ol style = 'display: grid; gap: 0.4rem; margin-left: 1.25rem;'>
				{ rows.map((row) => <li key = { row.key }>
					<div style = 'display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 0.45rem; min-width: 0;'>
						<img src = { getStatusIcon(row) } width = '18' height = '18' />
						<p class = 'paragraph ellipsis' title = { row.title } style = 'min-width: 0;'>{ row.title }</p>
					</div>
				</li>) }
			</ol>
		</div>
	</section>
}
