import { type Signal, type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { getMissingPopupReplyErrorMessage, requestPopupSimulateGnosisSafeTransaction } from '../../../background/backgroundUtils.js'
import { MessageToPopup, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../../../types/personal-message-definitions.js'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { SmallAddress } from '../../subcomponents/address.js'
import type { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { Transaction } from '../Transactions.js'
import { useEffect, useRef } from 'preact/hooks'
import { AsyncActionButton } from '../../subcomponents/AsyncAction.js'
import { type AsyncStates, useAsyncState } from '../../../utils/preact-utilities.js'

type ShowSuccessOrFailureParams = {
	activeAddress: ReadonlySignal<bigint | undefined>
	simulateExecutionReply: Signal<SimulateExecutionReply | undefined>
	gnosisSimulationState: AsyncStates
	requestErrorText: string | undefined
	requestToSimulate: () => void
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const GNOSIS_SIMULATION_REPLY_MISSING_ERROR = getMissingPopupReplyErrorMessage('Simulating Gnosis Safe execution')

const ShowSuccessOrFailure = ({ simulateExecutionReply, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack, gnosisSimulationState, requestErrorText, requestToSimulate }: ShowSuccessOrFailureParams) => {
	const errorText = useComputed(() => simulateExecutionReply.value?.data.success === false ? simulateExecutionReply.value.data.errorMessage : undefined)
	const rpcErrorText = useComputed(() => simulateExecutionReply.value?.data.success === true && simulateExecutionReply.value.data.result.visualizedSimulationState.success === false ? JSON.stringify(simulateExecutionReply.value.data.result.visualizedSimulationState.jsonRpcError, undefined, 4) : undefined)
	const simTx = useComputed(() => {
		if (simulateExecutionReply.value?.data.success !== true) return undefined
		const visualizedBlocks = simulateExecutionReply.value.data.result.visualizedSimulationState.visualizedBlocks
		const lastBlock = visualizedBlocks[visualizedBlocks.length - 1]
		if (lastBlock === undefined) return undefined
		return lastBlock.simulatedAndVisualizedTransactions[lastBlock.simulatedAndVisualizedTransactions.length - 1]
	})
	const addressMetaData = useComputed(() => {
		if (simulateExecutionReply.value === undefined || simulateExecutionReply.value.data.success === false) throw new Error('failed simulation')
		return simulateExecutionReply.value.data.result.addressBookEntries
	})
	const results = useComputed(() => {
		if (simulateExecutionReply.value === undefined || simulateExecutionReply.value.data.success === false) throw new Error('failed simulation')
		return {
			blockNumber: simulateExecutionReply.value.data.result.simulationState.blockNumber,
			blockTimestamp: simulateExecutionReply.value.data.result.simulationState.blockTimestamp,
			simulationConductedTimestamp: simulateExecutionReply.value.data.result.simulationState.simulationConductedTimestamp,
			simulationStateInput: simulateExecutionReply.value.data.result.simulationState.simulationStateInput,
			addressBookEntries: simulateExecutionReply.value.data.result.addressBookEntries,
			rpcNetwork: simulateExecutionReply.value.data.result.simulationState.rpcNetwork,
			tokenPriceEstimates: simulateExecutionReply.value.data.result.tokenPriceEstimates,
			activeAddress: activeAddress.value!,
			visualizedSimulationState: simulateExecutionReply.value.data.result.visualizedSimulationState,
			namedTokenIds: simulateExecutionReply.value.data.result.namedTokenIds,
		}
	})

	if (simulateExecutionReply.value === undefined) {
		return <div style = 'display: grid; row-gap: 10px;'>
			{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
			<div style = 'display: flex; justify-content: center;'>
				<AsyncActionButton
					class = 'button is-primary'
					state = { gnosisSimulationState }
					text = 'Simulate execution'
					pendingText = 'Simulating...'
					onClick = { requestToSimulate }
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
	if (simTx.value === undefined || activeAddress.value === undefined) return <></>

	return <div style = 'display: grid; grid-template-rows: max-content; row-gap: 10px;' >
		{ requestErrorText === undefined ? <></> : <ErrorComponent text = { requestErrorText }/> }
		<Transaction
			simTx = { simTx.value }
			simulationAndVisualisationResults = { results.value }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
			addressMetaData = { addressMetaData }
		/>
	</div>
}

type GnosisSafeVisualizerParams = {
	gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx
	activeAddress: bigint
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

export function GnosisSafeVisualizer(param: GnosisSafeVisualizerParams) {
	const simulateExecutionReply = useSignal<SimulateExecutionReply | undefined>(undefined)
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const { value: gnosisSimulationRequest, waitFor: waitForGnosisSimulation, reset: resetGnosisSimulationRequest } = useAsyncState<void>()
	const requestErrorText = useComputed(() => gnosisSimulationRequest.value.state === 'rejected' ? gnosisSimulationRequest.value.error.message : undefined)
	const currentMessageIdentifier = useRef(param.gnosisSafeMessage.messageIdentifier)
	currentMessageIdentifier.current = param.gnosisSafeMessage.messageIdentifier

	const isReplyForCurrentMessage = (reply: SimulateExecutionReply) => reply.data.transactionOrMessageIdentifier === currentMessageIdentifier.current

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') return false
			if (parsed.method !== 'popup_simulateExecutionReply') return false
			const { role: _role, ...popupSimulateExecutionReply } = parsed
			const reply = SimulateExecutionReply.parse(popupSimulateExecutionReply)
			if (!isReplyForCurrentMessage(reply)) return false
			simulateExecutionReply.value = reply
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		activeAddress.value = param.activeAddress
		simulateExecutionReply.value = undefined
		resetGnosisSimulationRequest()
	}, [param.activeAddress, param.gnosisSafeMessage.messageIdentifier])

	const requestToSimulate = () => {
		waitForGnosisSimulation(async () => {
			const reply = await requestPopupSimulateGnosisSafeTransaction({ gnosisSafeMessage: param.gnosisSafeMessage })
			if (reply === undefined) throw new Error(GNOSIS_SIMULATION_REPLY_MISSING_ERROR)
			if (param.gnosisSafeMessage.messageIdentifier !== currentMessageIdentifier.current || !isReplyForCurrentMessage(reply)) return
			simulateExecutionReply.value = reply
		})
	}

	if (activeAddress.value === undefined) return <></>
	return <>
		<div class = 'notification transaction-importance-box'>
			<span class = 'log-table' style = 'justify-content: center; grid-template-columns: auto auto auto'>
				<div class = 'log-cell'> <p class = 'paragraph'>Approves Gnosis Safe</p> </div>
				<div class = 'log-cell'> <SmallAddress addressBookEntry = { param.gnosisSafeMessage.verifyingContract } renameAddressCallBack = { param.renameAddressCallBack } /> </div>
				<div class = 'log-cell'> <p class = 'paragraph'>message</p> </div>
			</span>
		</div>
		<div class = 'notification dashed-notification'>
			<legend class = 'paragraph'>Outcome of the message, should the multisig approve it</legend>
			<ShowSuccessOrFailure
				simulateExecutionReply = { simulateExecutionReply }
				gnosisSimulationState = { gnosisSimulationRequest.value.state }
				requestErrorText = { requestErrorText.value }
				requestToSimulate = { requestToSimulate }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				activeAddress = { activeAddress }
			/>
		</div>
		{ simulateExecutionReply.value === undefined ? <></> :
			<div class = 'log-cell' style = 'justify-content: right; margin-top: 10px;'>
				<AsyncActionButton
					class = 'button is-primary is-small'
					state = { gnosisSimulationRequest.value.state }
					text = 'Refresh simulation'
					pendingText = 'Simulating...'
					onClick = { requestToSimulate }
				/>
			</div>
		}
	</>
}
