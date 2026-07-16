import { batch, type Signal, type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { MessageToPopup, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../../../types/personal-message-definitions.js'
import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { Spinner } from '../../subcomponents/Spinner.js'
import { SmallAddress } from '../../subcomponents/address.js'
import type { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { Transaction } from '../Transactions.js'
import { useEffect } from 'preact/hooks'

type ShowSuccessOrFailureParams = {
	activeAddress: ReadonlySignal<bigint | undefined>
	simulateExecutionReply: Signal<SimulateExecutionReply | undefined>
	simulationInProgress: ReadonlySignal<boolean>
	requestSimulation: () => void
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const requestToSimulate = (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGnosisSafeTransaction', data: { gnosisSafeMessage } })

const ShowSuccessOrFailure = ({ simulateExecutionReply, simulationInProgress, requestSimulation, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack }: ShowSuccessOrFailureParams) => {
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
		if (simulationInProgress.value) {
			return <div class = 'safe-outcome-panel__loading' role = 'status'>
				<Spinner height = '2.5rem'/>
				<p class = 'safe-outcome-panel__status'>Simulating approved outcome…</p>
				<p class = 'safe-outcome-panel__helper'>This may take a moment while the transaction is evaluated against the latest chain state.</p>
			</div>
		}

		return <div class = 'safe-outcome-panel__empty'>
			<p class = 'safe-outcome-panel__helper'>Preview the transaction that can execute if the Safe reaches its approval threshold.</p>
			<button class = 'btn btn--primary' type = 'button' onClick = { requestSimulation }>
				Simulate outcome
			</button>
		</div>
	}

	if (simulateExecutionReply.value.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			<ErrorComponent text = { errorText }/>
		</div>
	}
	if (simulateExecutionReply.value.data.result.visualizedSimulationState.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			<ErrorComponent text = { rpcErrorText }/>
		</div>
	}
	if (simTx.value === undefined || activeAddress.value === undefined) return <></>

	return <div style = 'display: grid; grid-template-rows: max-content' >
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
	const simulationInProgress = useSignal(false)
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const outcomeTitleId = `safe-outcome-title-${ param.gnosisSafeMessage.messageIdentifier.toString() }`
	const requestSimulation = () => {
		if (simulationInProgress.value) return
		batch(() => {
			simulateExecutionReply.value = undefined
			simulationInProgress.value = true
		})
		void requestToSimulate(param.gnosisSafeMessage)
	}

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') return false
			if (parsed.method !== 'popup_simulateExecutionReply') return false
			const { role: _role, ...popupSimulateExecutionReply } = parsed
			const reply = SimulateExecutionReply.parse(popupSimulateExecutionReply)
			if (reply.data.transactionOrMessageIdentifier !== param.gnosisSafeMessage.messageIdentifier) return false
			batch(() => {
				simulateExecutionReply.value = reply
				simulationInProgress.value = false
			})
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [param.gnosisSafeMessage.messageIdentifier])

	useEffect(() => {
		batch(() => {
			activeAddress.value = param.activeAddress
			simulateExecutionReply.value = undefined
			simulationInProgress.value = false
		})
	}, [param.activeAddress, param.gnosisSafeMessage.messageIdentifier])

	if (activeAddress.value === undefined) return <></>
	return <>
		<div class = 'notification transaction-importance-box'>
			<span class = 'log-table' style = 'justify-content: center; grid-template-columns: auto auto auto'>
				<div class = 'log-cell'> <p class = 'paragraph'>Approves Gnosis Safe</p> </div>
				<div class = 'log-cell'> <SmallAddress addressBookEntry = { param.gnosisSafeMessage.verifyingContract } renameAddressCallBack = { param.renameAddressCallBack } /> </div>
				<div class = 'log-cell'> <p class = 'paragraph'>message</p> </div>
			</span>
		</div>
		<section class = 'safe-outcome-panel' aria-labelledby = { outcomeTitleId }>
			<header class = 'safe-outcome-panel__header'>
				<div>
					<h3 class = 'safe-outcome-panel__title' id = { outcomeTitleId }>Outcome if approved</h3>
					<p class = 'safe-outcome-panel__description'>See what the Safe transaction would do if the multisig reaches its approval threshold.</p>
				</div>
				{ simulateExecutionReply.value === undefined || simulationInProgress.value
					? <></>
					: <button class = 'btn btn--outline safe-outcome-panel__refresh' type = 'button' onClick = { requestSimulation }>Refresh simulation</button>
				}
			</header>
			<div class = 'safe-outcome-panel__content' aria-live = 'polite' aria-busy = { simulationInProgress.value }>
				<ShowSuccessOrFailure
					simulateExecutionReply = { simulateExecutionReply }
					simulationInProgress = { simulationInProgress }
					requestSimulation = { requestSimulation }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					activeAddress = { activeAddress }
				/>
			</div>
		</section>
	</>
}
