import { type ReadonlySignal, type Signal, useComputed } from '@preact/signals'
import type { PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import type { RpcConnectionStatus, RenameAddressCallBack } from '../../types/user-interface-types.js'
import type { MaybeSimulatedTransaction } from '../../types/visualizer-types.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { Transaction } from '../simulationExplaining/Transactions.js'
import { getSimulationDisplayBlockNumber, SimulatedInBlockNumber } from '../simulationExplaining/SimulationSummary.js'

type PopupPendingTransactionBatch = Extract<PopupPendingTransactionOrSignableMessage, { readonly type: 'TransactionBatch' }>
type SimulatedPendingTransactionBatch = Exclude<PopupPendingTransactionBatch, { readonly transactionOrMessageCreationStatus: 'Crafting' }>

export function getTransactionBatchTitle(batch: PopupPendingTransactionBatch) {
	const callCount = batch.originalRequestParameters.params[0].calls.length
	return `Batch of ${ callCount } call${ callCount === 1 ? '' : 's' }`
}

export const getSimulatedTransactionBatch = (pending: PopupPendingTransactionOrSignableMessage | undefined) => (
	pending?.type === 'TransactionBatch' && pending.transactionOrMessageCreationStatus !== 'Crafting' ? pending : undefined
)

// Simulation results for each call in request order. A call without results could not be prepared or simulated.
function getTransactionBatchCallResults(batch: SimulatedPendingTransactionBatch): readonly (MaybeSimulatedTransaction | undefined)[] {
	if (batch.popupVisualisation.statusCode !== 'success') return batch.transactionsToSimulate.map(() => undefined)
	const simulatedTransactions = batch.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
	return batch.transactionsToSimulate.map((transactionToSimulate) => simulatedTransactions.find((simulatedTransaction) => simulatedTransaction.transactionIdentifier === transactionToSimulate.transactionIdentifier))
}

// The batch is approved as a whole: every call must be simulated, and calls that fail or trip a protector need the explicit force-send acknowledgement.
export function getTransactionBatchApprovalBlocker(batch: SimulatedPendingTransactionBatch): 'notSimulated' | 'requiresForceSend' | undefined {
	if (batch.transactionOrMessageCreationStatus !== 'Simulated') return 'notSimulated'
	const callResults = getTransactionBatchCallResults(batch)
	if (callResults.some((callResult) => callResult === undefined)) return 'notSimulated'
	if (callResults.some((callResult) => callResult?.transactionStatus !== 'Transaction Succeeded' || callResult.quarantine)) return 'requiresForceSend'
	return undefined
}

export function getTransactionBatchErrorMessage(batch: SimulatedPendingTransactionBatch) {
	if (batch.popupVisualisation.statusCode === 'failed') return batch.popupVisualisation.data.error.decodedErrorMessage
	const failedPreparation = batch.transactionsToSimulate.find((transactionToSimulate) => !transactionToSimulate.success)
	if (failedPreparation !== undefined) return failedPreparation.error.message
	const failedCall = getTransactionBatchCallResults(batch).find((callResult) => callResult !== undefined && callResult.transactionStatus !== 'Transaction Succeeded')
	return failedCall?.error.message
}

type TransactionBatchCardParams = {
	currentPendingTransaction: ReadonlySignal<PopupPendingTransactionOrSignableMessage | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	currentBlockNumber: Signal<bigint | undefined>
	rpcConnectionStatus: Signal<RpcConnectionStatus>
}

export function TransactionBatchCard(param: TransactionBatchCardParams) {
	const batch = useComputed(() => getSimulatedTransactionBatch(param.currentPendingTransaction.value))
	const activeAddress = useComputed(() => batch.value?.activeAddress)
	const addressMetaData = useComputed(() => batch.value?.popupVisualisation.statusCode === 'success' ? batch.value.popupVisualisation.data.addressBookEntries : [])
	const currentBatch = batch.value
	if (currentBatch === undefined) return <></>
	const popupVisualisation = currentBatch.popupVisualisation
	const simulationAndVisualisationResults = popupVisualisation.statusCode === 'success' ? {
		blockNumber: popupVisualisation.data.simulationState.blockNumber,
		blockTimestamp: popupVisualisation.data.simulationState.blockTimestamp,
		simulationConductedTimestamp: popupVisualisation.data.simulationState.simulationConductedTimestamp,
		simulationStateInput: popupVisualisation.data.simulationState.simulationStateInput,
		addressBookEntries: popupVisualisation.data.addressBookEntries,
		rpcNetwork: popupVisualisation.data.simulationState.rpcNetwork,
		tokenPriceEstimates: popupVisualisation.data.tokenPriceEstimates,
		visualizedSimulationState: popupVisualisation.data.visualizedSimulationState,
		namedTokenIds: popupVisualisation.data.namedTokenIds,
	} : undefined
	const callResults = getTransactionBatchCallResults(currentBatch)
	const callCount = currentBatch.transactionsToSimulate.length
	const simulationBlockNumber = popupVisualisation.statusCode === 'success'
		? getSimulationDisplayBlockNumber(popupVisualisation.data.simulationState.blockNumber, popupVisualisation.data.visualizedSimulationState.visualizedBlocks.length)
		: popupVisualisation.data.simulationState.blockNumber
	return <div class = 'card'>
		<header class = 'card-header'>
			<p class = 'card-header-title' style = 'white-space: nowrap;'>{ getTransactionBatchTitle(currentBatch) }</p>
			<WebsiteOriginText website = { currentBatch.website } class = 'card-header-website' />
		</header>
		<div class = 'card-content' style = 'padding-bottom: 5px;'>
			<p class = 'paragraph' style = 'margin-bottom: 10px;'>Approving adds all of these calls, in this order, to the simulation stack as separate transactions.</p>
			{ popupVisualisation.statusCode === 'failed' ? <ErrorComponent text = { `The batch could not be simulated: ${ popupVisualisation.data.error.decodedErrorMessage }` } containerStyle = { { margin: '0px', marginBottom: '10px' } } /> : <></> }
			{ currentBatch.transactionsToSimulate.map((transactionToSimulate, callIndex) => {
				const callLabel = `Call ${ callIndex + 1 } of ${ callCount }`
				const simTx = callResults[callIndex]
				return <div key = { transactionToSimulate.transactionIdentifier.toString() } style = 'margin-bottom: 10px;'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color); margin-bottom: 5px;'>{ callLabel }</p>
					{ !transactionToSimulate.success
						? <ErrorComponent text = { `${ callLabel } cannot be sent: ${ transactionToSimulate.error.message }` } containerStyle = { { margin: '0px' } } />
						: simTx === undefined || simulationAndVisualisationResults === undefined
							? <ErrorComponent text = { `${ callLabel } is missing from the simulation.` } containerStyle = { { margin: '0px' } } />
							: <Transaction
								simTx = { simTx }
								simulationAndVisualisationResults = { simulationAndVisualisationResults }
								removeTransactionOrSignedMessage = { undefined }
								activeAddress = { activeAddress }
								renameAddressCallBack = { param.renameAddressCallBack }
								addressMetaData = { addressMetaData }
								editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
								gasLimitEditable = { false }
							/>
					}
				</div>
			}) }
			<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto;'>
				<div class = 'log-cell' style = 'justify-content: right;'>
					<SimulatedInBlockNumber
						simulationBlockNumber = { simulationBlockNumber }
						currentBlockNumber = { param.currentBlockNumber }
						simulationConductedTimestamp = { popupVisualisation.data.simulationState.simulationConductedTimestamp }
						rpcConnectionStatus = { param.rpcConnectionStatus }
					/>
				</div>
			</span>
		</div>
	</div>
}
