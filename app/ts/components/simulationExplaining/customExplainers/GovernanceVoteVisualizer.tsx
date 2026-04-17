import { Signal, type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { MessageToPopup, GovernanceVoteInputParameters, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedTransaction } from '../../../types/visualizer-types.js'
import { EthereumQuantity } from '../../../types/wire-types.js'
import { checksummedAddress, dataStringWith0xStart } from '../../../utils/bigint.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { CellElement } from '../../ui-utils.js'
import { Transaction } from '../Transactions.js'
import { useEffect } from 'preact/hooks'
import { resolveSignal, type SignalOrValue } from '../../../utils/signals.js'

type MissingAbiParams = {
	errorMessage: string
	addressBookEntry: AddressBookEntry | undefined
	renameAddressCallBack: (entry: AddressBookEntry) => void
}

function MissingAbi(params: MissingAbiParams) {
	return <div style = 'display: block'>
		<ErrorComponent warning = { false } text = { params.errorMessage }/>
		<div style = 'display: flex; justify-content: center; padding-top: 10px'>
			{ params.addressBookEntry === undefined ? <></> :
				<button class = { 'button is-primary' } onClick = { () => params.addressBookEntry !== undefined && params.renameAddressCallBack(params.addressBookEntry) }>
					Add Abi
				</button>
			}
		</div>
	</div>
}


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
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const simulateGovernanceVote = (transactionIdentifier: EthereumQuantity) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGovernanceContractExecution', data: { transactionIdentifier } })

const ShowSuccessOrFailure = ({ simulateExecutionReply, simTx, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack }: ShowSuccessOrFailureParams) => {
	const missingAbiText = 'The governance contract is missing an ABI. Add an ABI to simulate execution of this proposal.'
	const errorText = useComputed(() => simulateExecutionReply.value?.data.success === false ? simulateExecutionReply.value.data.errorMessage : undefined)
	const rpcErrorText = useComputed(() => simulateExecutionReply.value?.data.success === true && simulateExecutionReply.value.data.result.visualizedSimulationState.success === false ? JSON.stringify(simulateExecutionReply.value.data.result.visualizedSimulationState.jsonRpcError, undefined, 4) : undefined)
	const govSimTx = useComputed(() => simulateExecutionReply.value?.data.success === true ? simulateExecutionReply.value.data.result.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1) : undefined)
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

	if (simTx.value === undefined || activeAddress.value === undefined) return <></>
	if (simulateExecutionReply.value === undefined) {
		return <div style = 'display: flex; justify-content: center;'>
			{ simTx.value.transaction.to !== undefined && 'abi' in simTx.value.transaction.to && simTx.value.transaction.to.abi !== undefined ?
				<button
					class = { 'button is-primary' }
					onClick = { () => simulateGovernanceVote(simTx.value!.transactionIdentifier) }
					disabled = { false }
				>
					Simulate execution on a passing vote
				</button>
			: <> <MissingAbi
					errorMessage = { missingAbiText }
					addressBookEntry = { simTx.value.transaction.to }
					renameAddressCallBack = { renameAddressCallBack }
				/>
			</> }
		</div>
	}
	if (simulateExecutionReply.value.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			{ simulateExecutionReply.value.data.errorType === 'MissingAbi' ? <MissingAbi
				errorMessage = { missingAbiText }
				addressBookEntry = { simulateExecutionReply.value.data.errorAddressBookEntry }
				renameAddressCallBack = { renameAddressCallBack }
			/> : <ErrorComponent text = { errorText }/> }
		</div>
	}
	if (simulateExecutionReply.value.data.result.visualizedSimulationState.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			<ErrorComponent text = { rpcErrorText }/>
		</div>
	}
	if (govSimTx.value === undefined) return <></>

	return <div style = 'display: grid; grid-template-rows: max-content' >
		<Transaction
			simTx = { govSimTx.value }
			simulationAndVisualisationResults = { results }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
			addressMetaData = { addressMetaData }
		/>
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

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') return false
			if (parsed.method !== 'popup_simulateExecutionReply') return false
			const { role: _role, ...popupSimulateExecutionReply } = parsed
			const reply = SimulateExecutionReply.parse(popupSimulateExecutionReply)
			if (reply.data.transactionOrMessageIdentifier !== param.simTx.transactionIdentifier) return false
			simulateExecutionReply.value = reply
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		governanceVoteInputParameters.value = param.governanceVoteInputParameters
		simTx.value = param.simTx
		activeAddress.value = param.activeAddress.value
		simulateExecutionReply.value = undefined
	}, [param.simTx.transactionIdentifier, param.governanceVoteInputParameters, param.activeAddress.value])

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
						<button class = { 'button is-primary is-small' } onClick = { () => simulateGovernanceVote(simTx.value!.transactionIdentifier) }>Refresh</button>
					}
				</div>
			</span>
		</div>

		<div class = 'notification dashed-notification'>
			<ShowSuccessOrFailure
				simulateExecutionReply = { simulateExecutionReply }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				simTx = { simTx }
				activeAddress = { activeAddress }
			/>
		</div>
	</>
}
