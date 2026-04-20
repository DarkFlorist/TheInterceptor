import { Signal, type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { MessageToPopup, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import { VisualizedPersonalSignRequestSafeTx } from '../../../types/personal-message-definitions.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { Transaction } from '../Transactions.js'
import { useEffect } from 'preact/hooks'

type ShowSuccessOrFailureParams = {
	gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx
	activeAddress: ReadonlySignal<bigint | undefined>
	simulateExecutionReply: Signal<SimulateExecutionReply | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const requestToSimulate = (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGnosisSafeTransaction', data: { gnosisSafeMessage } })

const ShowSuccessOrFailure = ({ simulateExecutionReply, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack, gnosisSafeMessage }: ShowSuccessOrFailureParams) => {
	const errorText = useComputed(() => simulateExecutionReply.value?.data.success === false ? simulateExecutionReply.value.data.errorMessage : undefined)
	const rpcErrorText = useComputed(() => simulateExecutionReply.value?.data.success === true && simulateExecutionReply.value.data.result.visualizedSimulationState.success === false ? JSON.stringify(simulateExecutionReply.value.data.result.visualizedSimulationState.jsonRpcError, undefined, 4) : undefined)
	const simTx = useComputed(() => simulateExecutionReply.value?.data.success === true ? simulateExecutionReply.value.data.result.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1) : undefined)
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
			addressBookEntries: simulateExecutionReply.value.data.result.addressBookEntries,
			rpcNetwork: simulateExecutionReply.value.data.result.simulationState.rpcNetwork,
			tokenPriceEstimates: simulateExecutionReply.value.data.result.tokenPriceEstimates,
			activeAddress: activeAddress.value!,
			visualizedSimulationState: simulateExecutionReply.value.data.result.visualizedSimulationState,
			namedTokenIds: simulateExecutionReply.value.data.result.namedTokenIds,
		}
	})

	if (simulateExecutionReply.value === undefined) {
		return <div style = 'display: flex; justify-content: center;'>
			<button
				class = { 'button is-primary' }
				onClick = { () => requestToSimulate(gnosisSafeMessage) }
				disabled = { false }
			>
				Simulate execution
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
			simulationAndVisualisationResults = { results }
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
			simulateExecutionReply.value = reply
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		activeAddress.value = param.activeAddress
		simulateExecutionReply.value = undefined
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
		<div class = 'notification dashed-notification'>
			<legend class = 'paragraph'>Outcome of the message, should the multisig approve it</legend>
			<ShowSuccessOrFailure
				gnosisSafeMessage = { param.gnosisSafeMessage }
				simulateExecutionReply = { simulateExecutionReply }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				activeAddress = { activeAddress }
			/>
		</div>
		{ simulateExecutionReply.value === undefined ? <></> :
			<div class = 'log-cell' style = 'justify-content: right; margin-top: 10px;'>
				<button class = { 'button is-primary is-small' } onClick = { () => requestToSimulate(param.gnosisSafeMessage) }>Refresh simulation</button>
			</div>
		}
	</>
}
