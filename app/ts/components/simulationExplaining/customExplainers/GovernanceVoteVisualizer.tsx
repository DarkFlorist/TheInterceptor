import { type Signal, type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { getMissingPopupReplyErrorMessage, requestPopupSimulateGovernanceContractExecution } from '../../../background/backgroundUtils.js'
import { MessageToPopup, type GovernanceVoteInputParameters, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import type { BlockTimeManipulation, SimulatedAndVisualizedTransaction } from '../../../types/visualizer-types.js'
import { bigintSecondsToDate, checksummedAddress, dataStringWith0xStart } from '../../../utils/bigint.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import type { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { CellElement } from '../../ui-utils.js'
import { Transaction } from '../Transactions.js'
import { useEffect, useRef } from 'preact/hooks'
import { resolveSignal, type SignalOrValue } from '../../../utils/signals.js'
import { AsyncActionButton } from '../../subcomponents/AsyncAction.js'
import { type AsyncStates, useAsyncState } from '../../../utils/preact-utilities.js'

function VotePanel({ inputParams }: { inputParams: SignalOrValue<GovernanceVoteInputParameters | undefined> }) {
	const resolvedInputParams = resolveSignal(inputParams)
	if (resolvedInputParams === undefined) return <></>
	const interpretSupport = (support: bigint | boolean) => {
		if (support === true || support === 1n) return 'For'
		if (support === false || support === 0n) return 'Against'
		if (support === 2n) return 'Abstain'
		return `Support: ${ support }`
	}

	return <>
		<div class = 'notification transaction-importance-box'>
			<div style = 'display: flex; justify-content: center;' >
				<p style = { { 'font-size': 'var(--big-font-size)' } } >
					Vote&nbsp;<b>{ interpretSupport(resolvedInputParams.support) }</b>&nbsp;{`for proposal: ${ resolvedInputParams.proposalId } `}
				</p>
			</div>
		</div>

		{ resolvedInputParams.reason !== undefined || resolvedInputParams.signature !== undefined || resolvedInputParams.voter !== undefined || resolvedInputParams.params !== undefined ? <>
			<div class = 'container'>
				<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; row-gap: 5px; grid-template-columns: auto auto'>
					{ resolvedInputParams.reason !== undefined ? <>
						<CellElement text = 'Reason:'/>
						<CellElement text =  { resolvedInputParams.reason }/>
					</> : <></> }
					{ resolvedInputParams.signature !== undefined ? <>
						<CellElement text = 'Signature:'/>
						<CellElement text = { dataStringWith0xStart(resolvedInputParams.signature) } />
					</> : <></> }
					{ resolvedInputParams.voter !== undefined ? <>
						<CellElement text = 'Voter:'/>
						<CellElement text = { checksummedAddress(resolvedInputParams.voter) } />
					</> : <></> }
					{ resolvedInputParams.params !== undefined ? <>
						<CellElement text = 'Additional Data Included With Your Vote: '/>
						<CellElement text = { dataStringWith0xStart(resolvedInputParams.params) } />
					</> : <></> }
				</span>
			</div>
		</> : <></> }
	</>
}

type ShowSuccessOrFailureParams = {
	simTx: Signal<SimulatedAndVisualizedTransaction | undefined>
	activeAddress: ReadonlySignal<bigint | undefined>
	simulateExecutionReply: Signal<SimulateExecutionReply | undefined>
	governanceSimulationState: AsyncStates
	requestErrorText: string | undefined
	simulateGovernanceVote: () => void
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const GOVERNANCE_SIMULATION_REPLY_MISSING_ERROR = getMissingPopupReplyErrorMessage('Simulating governance execution')

const formatExecutionTime = (blockTimeManipulation: BlockTimeManipulation | undefined) => {
	if (blockTimeManipulation?.type !== 'SetTimetamp') return undefined
	return bigintSecondsToDate(blockTimeManipulation.timeToSet).toUTCString()
}

const ShowSuccessOrFailure = ({ simulateExecutionReply, simTx, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack, governanceSimulationState, requestErrorText, simulateGovernanceVote }: ShowSuccessOrFailureParams) => {
	const errorText = useComputed(() => simulateExecutionReply.value?.data.success === false ? simulateExecutionReply.value.data.errorMessage : undefined)
	const rpcErrorText = useComputed(() => simulateExecutionReply.value?.data.success === true && simulateExecutionReply.value.data.result.visualizedSimulationState.success === false ? JSON.stringify(simulateExecutionReply.value.data.result.visualizedSimulationState.jsonRpcError, undefined, 4) : undefined)
	// The background simulates the proposal's execution as the last block of the reply. A Compound Timelock executes each action in its own call, so that block can hold several transactions.
	const executionBlock = useComputed(() => {
		if (simulateExecutionReply.value?.data.success !== true) return undefined
		const visualizedBlocks = simulateExecutionReply.value.data.result.visualizedSimulationState.visualizedBlocks
		return visualizedBlocks[visualizedBlocks.length - 1]
	})
	const addressMetaData = useComputed(() => {
		if (simulateExecutionReply.value === undefined || simulateExecutionReply.value.data.success === false) return []
		return simulateExecutionReply.value.data.result.addressBookEntries
	})
	const results = useComputed(() => {
		if (simulateExecutionReply.value === undefined || simulateExecutionReply.value.data.success === false || activeAddress.value === undefined) return undefined
		return {
			blockNumber: simulateExecutionReply.value.data.result.simulationState.blockNumber,
			blockTimestamp: simulateExecutionReply.value.data.result.simulationState.blockTimestamp,
			simulationConductedTimestamp: simulateExecutionReply.value.data.result.simulationState.simulationConductedTimestamp,
			simulationStateInput: simulateExecutionReply.value.data.result.simulationState.simulationStateInput,
			addressBookEntries: simulateExecutionReply.value.data.result.addressBookEntries,
			rpcNetwork: simulateExecutionReply.value.data.result.simulationState.rpcNetwork,
			tokenPriceEstimates: simulateExecutionReply.value.data.result.tokenPriceEstimates,
			activeAddress: activeAddress.value,
			visualizedSimulationState: simulateExecutionReply.value.data.result.visualizedSimulationState,
			namedTokenIds: simulateExecutionReply.value.data.result.namedTokenIds,
		}
	})

	if (simTx.value === undefined || activeAddress.value === undefined) return <></>
	if (simulateExecutionReply.value === undefined) {
		return <div style = 'display: grid; row-gap: 10px;'>
			{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
			<div style = 'display: flex; justify-content: center;'>
				<AsyncActionButton
					class = 'button is-primary'
					state = { governanceSimulationState }
					text = 'Simulate execution on a passing vote'
					pendingText = 'Simulating...'
					onClick = { simulateGovernanceVote }
				/>
			</div>
		</div>
	}
	if (simulateExecutionReply.value.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content; row-gap: 10px;' >
			{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
			<ErrorComponent text = { errorText }/>
		</div>
	}
	if (simulateExecutionReply.value.data.result.visualizedSimulationState.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content; row-gap: 10px;' >
			{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
			<ErrorComponent text = { rpcErrorText }/>
		</div>
	}
	const simulationAndVisualisationResults = results.value
	if (executionBlock.value === undefined || simulationAndVisualisationResults === undefined) return <></>
	const executionTime = formatExecutionTime(executionBlock.value.blockTimeManipulation)

	return <div style = 'display: grid; grid-template-rows: max-content; row-gap: 10px;' >
		{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
		{ executionTime === undefined ? <></> : <p class = 'paragraph'>{ `Executed by the governor's timelock on ${ executionTime }` }</p> }
		{ executionBlock.value.simulatedAndVisualizedTransactions.map((executionTransaction) => <Transaction
			key = { executionTransaction.transactionIdentifier.toString() }
			simTx = { executionTransaction }
			simulationAndVisualisationResults = { simulationAndVisualisationResults }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
			addressMetaData = { addressMetaData }
		/>) }
	</div>
}

type GovernanceVoteVisualizerParams = {
	simTx: SimulatedAndVisualizedTransaction
	activeAddress: ReadonlySignal<bigint | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	governanceVoteInputParameters: GovernanceVoteInputParameters
}

export function GovernanceVoteVisualizer(param: GovernanceVoteVisualizerParams) {
	const simulateExecutionReply = useSignal<SimulateExecutionReply | undefined>(undefined)
	const governanceVoteInputParameters = useSignal<GovernanceVoteInputParameters | undefined>(undefined)
	const simTx = useSignal<SimulatedAndVisualizedTransaction | undefined>(undefined)
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const { value: governanceSimulationRequest, waitFor: waitForGovernanceSimulation, reset: resetGovernanceSimulationRequest } = useAsyncState<void>()
	const requestErrorText = useComputed(() => governanceSimulationRequest.value.state === 'rejected' ? governanceSimulationRequest.value.error.message : undefined)
	const currentTransactionIdentifier = useRef(param.simTx.transactionIdentifier)
	currentTransactionIdentifier.current = param.simTx.transactionIdentifier

	const isReplyForCurrentTransaction = (reply: SimulateExecutionReply) => reply.data.transactionOrMessageIdentifier === currentTransactionIdentifier.current

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') return false
			if (parsed.method !== 'popup_simulateExecutionReply') return false
			const { role: _role, ...popupSimulateExecutionReply } = parsed
			const reply = SimulateExecutionReply.parse(popupSimulateExecutionReply)
			if (!isReplyForCurrentTransaction(reply)) return false
			resetGovernanceSimulationRequest()
			simulateExecutionReply.value = reply
			return false
		}
		return noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
	}, [])

	useEffect(() => {
		governanceVoteInputParameters.value = param.governanceVoteInputParameters
		simTx.value = param.simTx
		activeAddress.value = param.activeAddress.value
		simulateExecutionReply.value = undefined
		resetGovernanceSimulationRequest()
	}, [param.simTx.transactionIdentifier, param.governanceVoteInputParameters, param.activeAddress.value])

	const simulateGovernanceVote = () => {
		const transactionIdentifier = simTx.value?.transactionIdentifier
		if (transactionIdentifier === undefined) return
		waitForGovernanceSimulation(async () => {
			const reply = await requestPopupSimulateGovernanceContractExecution({ transactionIdentifier })
			if (reply === undefined) throw new Error(GOVERNANCE_SIMULATION_REPLY_MISSING_ERROR)
			if (transactionIdentifier !== currentTransactionIdentifier.current || !isReplyForCurrentTransaction(reply)) return
			simulateExecutionReply.value = reply
		})
	}

	if (governanceVoteInputParameters.value === undefined || simTx.value === undefined || activeAddress.value === undefined) return <></>
	return <>
	<VotePanel inputParams = { governanceVoteInputParameters } />

		<div style = 'display: grid; grid-template-rows: max-content max-content'>
				<span class = 'log-table' style = 'padding-bottom: 10px; grid-template-columns: auto auto;'>
					<div class = 'log-cell'>
						<p class = 'paragraph'>Simulation of this proposal's outcome should the vote pass:</p>
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						{ simulateExecutionReply.value === undefined ? <></> :
							<AsyncActionButton
								class = 'button is-primary is-small'
								state = { governanceSimulationRequest.value.state }
								text = 'Refresh'
								pendingText = 'Simulating...'
								onClick = { simulateGovernanceVote }
							/>
						}
					</div>
				</span>
		</div>

			<div class = 'notification dashed-notification'>
				<ShowSuccessOrFailure
					simulateExecutionReply = { simulateExecutionReply }
					governanceSimulationState = { governanceSimulationRequest.value.state }
					requestErrorText = { requestErrorText.value }
					simulateGovernanceVote = { simulateGovernanceVote }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					simTx = { simTx }
				activeAddress = { activeAddress }
			/>
		</div>
	</>
}
