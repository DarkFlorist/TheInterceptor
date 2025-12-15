import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { MessageToPopup, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import { VisualizedPersonalSignRequestSafeTx } from '../../../types/personal-message-definitions.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { Transaction } from '../Transactions.js'
import { useEffect, useState } from 'preact/hooks'

type ShowSuccessOrFailureParams = {
	gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx
	currentBlockNumber: undefined | bigint
	rpcConnectionStatus: RpcConnectionStatus
	activeAddress: bigint
	simulateExecutionReply: SimulateExecutionReply | undefined
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const requestToSimulate = (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGnosisSafeTransaction', data: { gnosisSafeMessage } })

const ShowSuccessOrFailure = ({ simulateExecutionReply, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack, gnosisSafeMessage }: ShowSuccessOrFailureParams) => {
	if (simulateExecutionReply === undefined) {
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

	if (simulateExecutionReply.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			<ErrorComponent text = { simulateExecutionReply.data.errorMessage }/>
		</div>
	}
	const simTx = simulateExecutionReply.data.result.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	if (simTx === undefined) return <></>
	return <div style = 'display: grid; grid-template-rows: max-content' >
		<Transaction
			simTx = { simTx }
			simulationAndVisualisationResults = { {
				blockNumber: simulateExecutionReply.data.result.simulationState.blockNumber,
				blockTimestamp: simulateExecutionReply.data.result.simulationState.blockTimestamp,
				simulationConductedTimestamp: simulateExecutionReply.data.result.simulationState.simulationConductedTimestamp,
				addressBookEntries: simulateExecutionReply.data.result.addressBookEntries,
				rpcNetwork: simulateExecutionReply.data.result.simulationState.rpcNetwork,
				tokenPriceEstimates: simulateExecutionReply.data.result.tokenPriceEstimates,
				activeAddress: activeAddress,
				visualizedSimulationState: simulateExecutionReply.data.result.visualizedSimulationState,
				namedTokenIds: simulateExecutionReply.data.result.namedTokenIds,
			} }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
			addressMetaData = { simulateExecutionReply.data.result.addressBookEntries }
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
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [simulateExecutionReply, setSimulateExecutionReply] = useState<SimulateExecutionReply | undefined>(undefined)

	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)

	useEffect(() => {
		const popupMessageListener = (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				return setCurrentBlockNumber(parsed.data.rpcConnectionStatus?.latestBlock?.number)
			}
			if (parsed.method !== 'popup_simulateExecutionReply') return
			const reply = SimulateExecutionReply.parse(parsed)
			if (reply.data.transactionOrMessageIdentifier !== param.gnosisSafeMessage.messageIdentifier) return
			return setSimulateExecutionReply(reply)
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => {
		setActiveAddress(param.activeAddress)
		setSimulateExecutionReply(undefined)
	}, [param.activeAddress, param.gnosisSafeMessage.messageIdentifier])

	if (activeAddress === undefined) return <></>
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
				currentBlockNumber = { currentBlockNumber }
				rpcConnectionStatus = { rpcConnectionStatus }
				simulateExecutionReply = { simulateExecutionReply }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				activeAddress = { activeAddress }
			/>
		</div>
		{ simulateExecutionReply === undefined ? <></> :
			<div class = 'log-cell' style = 'justify-content: right; margin-top: 10px;'>
				<button class = { 'button is-primary is-small' } onClick = { () => requestToSimulate(param.gnosisSafeMessage) }>Refresh simulation</button>
			</div>
		}
	</>
}
