import { useComputed } from '@preact/signals'
import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { MessageToPopup, GovernanceVoteInputParameters, SimulateExecutionReply } from '../../../types/interceptor-messages.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedTransaction } from '../../../types/visualizer-types.js'
import { EthereumQuantity } from '../../../types/wire-types.js'
import { checksummedAddress, dataStringWith0xStart } from '../../../utils/bigint.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../../utils/browser.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
import { EditEnsNamedHashCallBack } from '../../subcomponents/ens.js'
import { CellElement } from '../../ui-utils.js'
import { Transaction } from '../Transactions.js'
import { useEffect, useState } from 'preact/hooks'

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


function VotePanel({ inputParams }: { inputParams: GovernanceVoteInputParameters }) {
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
					Vote&nbsp;<b>{ interpretSupport(inputParams.support) }</b>&nbsp;{`for proposal: ${ inputParams.proposalId } `}
				</p>
			</div>
		</div>

		{ inputParams.reason !== undefined || inputParams.signature !== undefined || inputParams.voter !== undefined || inputParams.params !== undefined ? <>
			<div class = 'container'>
				<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; row-gap: 5px; grid-template-columns: auto auto'>
					{ inputParams.reason !== undefined ? <>
						<CellElement text = 'Reason:'/>
						<CellElement text =  { inputParams.reason }/>
					</> : <></> }
					{ inputParams.signature !== undefined ? <>
						<CellElement text = 'Signature:'/>
						<CellElement text = { dataStringWith0xStart(inputParams.signature) } />
					</> : <></> }
					{ inputParams.voter !== undefined ? <>
						<CellElement text = 'Voter:'/>
						<CellElement text = { checksummedAddress(inputParams.voter) } />
					</> : <></> }
					{ inputParams.params !== undefined ? <>
						<CellElement text = 'Additional Data Included With Your Vote: '/>
						<CellElement text = { dataStringWith0xStart(inputParams.params) } />
					</> : <></> }
				</span>
			</div>
		</> : <></> }
	</>
}

type ShowSuccessOrFailureParams = {
	simTx: SimulatedAndVisualizedTransaction
	currentBlockNumber: undefined | bigint
	rpcConnectionStatus: RpcConnectionStatus
	activeAddress: bigint
	simulateExecutionReply: SimulateExecutionReply | undefined
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

const simulateGovernanceVote = (transactionIdentifier: EthereumQuantity) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGovernanceContractExecution', data: { transactionIdentifier } })

const ShowSuccessOrFailure = ({ simulateExecutionReply, simTx, activeAddress, renameAddressCallBack, editEnsNamedHashCallBack }: ShowSuccessOrFailureParams) => {
	const missingAbiText = 'The governance contract is missing an ABI. Add an ABI to simulate execution of this proposal.'
	if (simulateExecutionReply === undefined) {
		return <div style = 'display: flex; justify-content: center;'>
			{ simTx.transaction.to !== undefined && 'abi' in simTx.transaction.to && simTx.transaction.to.abi !== undefined ?
				<button
					class = { 'button is-primary' }
					onClick = { () => simulateGovernanceVote(simTx.transactionIdentifier) }
					disabled = { false }
				>
					Simulate execution on a passing vote
				</button>
			: <> <MissingAbi
					errorMessage = { missingAbiText }
					addressBookEntry = { simTx.transaction.to }
					renameAddressCallBack = { renameAddressCallBack }
				/>
			</> }
		</div>
	}
	if (simulateExecutionReply.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			{ simulateExecutionReply.data.errorType === 'MissingAbi' ? <MissingAbi
				errorMessage = { missingAbiText }
				addressBookEntry = { simulateExecutionReply.data.errorAddressBookEntry }
				renameAddressCallBack = { renameAddressCallBack }
			/> : <ErrorComponent text = { simulateExecutionReply.data.errorMessage }/> }
		</div>
	}
	const govSimTx = simulateExecutionReply.data.result.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	if (govSimTx === undefined) return <></>

	const results = useComputed(() => {
		if (simulateExecutionReply.data.success === false) throw new Error('failed simulation')
		return {
			blockNumber: simulateExecutionReply.data.result.simulationState.blockNumber,
			blockTimestamp: simulateExecutionReply.data.result.simulationState.blockTimestamp,
			simulationConductedTimestamp: simulateExecutionReply.data.result.simulationState.simulationConductedTimestamp,
			addressBookEntries: simulateExecutionReply.data.result.addressBookEntries,
			rpcNetwork: simulateExecutionReply.data.result.simulationState.rpcNetwork,
			tokenPriceEstimates: simulateExecutionReply.data.result.tokenPriceEstimates,
			activeAddress: activeAddress,
			visualizedSimulationState: simulateExecutionReply.data.result.visualizedSimulationState,
			namedTokenIds: simulateExecutionReply.data.result.namedTokenIds,
		}
	})

	return <div style = 'display: grid; grid-template-rows: max-content' >
		<Transaction
			simTx = { govSimTx }
			simulationAndVisualisationResults = { results }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
			addressMetaData = { simulateExecutionReply.data.result.addressBookEntries }
		/>
	</div>
}

type GovernanceVoteVisualizerParams = {
	simTx: SimulatedAndVisualizedTransaction
	activeAddress: bigint
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	governanceVoteInputParameters: GovernanceVoteInputParameters
}

export function GovernanceVoteVisualizer(param: GovernanceVoteVisualizerParams) {
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [simulateExecutionReply, setSimulateExecutionReply] = useState<SimulateExecutionReply | undefined>(undefined)

	const [governanceVoteInputParameters, setGovernanceVoteInputParameters] = useState<GovernanceVoteInputParameters | undefined>(undefined)
	const [simTx, setSimTx] = useState<SimulatedAndVisualizedTransaction | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				setCurrentBlockNumber(parsed.data.rpcConnectionStatus?.latestBlock?.number)
				return false
			}
			if (parsed.method !== 'popup_simulateExecutionReply') return false
			const reply = SimulateExecutionReply.parse(parsed)
			if (reply.data.transactionOrMessageIdentifier !== param.simTx.transactionIdentifier) return false
			setSimulateExecutionReply(reply)
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => {
		setGovernanceVoteInputParameters(param.governanceVoteInputParameters)
		setSimTx(param.simTx)
		setActiveAddress(param.activeAddress)
		setSimulateExecutionReply(undefined)
	}, [param.simTx.transactionIdentifier])

	if (governanceVoteInputParameters === undefined || simTx === undefined || activeAddress === undefined) return <></>
	return <>
		<VotePanel inputParams = { governanceVoteInputParameters } />

		<div style = 'display: grid; grid-template-rows: max-content max-content'>
			<span class = 'log-table' style = 'padding-bottom: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<p class = 'paragraph'>Simulation of this proposal's outcome should the vote pass:</p>
				</div>
				<div class = 'log-cell' style = 'justify-content: right;'>
					{ simulateExecutionReply === undefined ? <></> :
						<button class = { 'button is-primary is-small' } onClick = { () => simulateGovernanceVote(simTx.transactionIdentifier) }>Refresh</button>
					}
				</div>
			</span>
		</div>

		<div class = 'notification dashed-notification'>
			<ShowSuccessOrFailure
				currentBlockNumber = { currentBlockNumber }
				rpcConnectionStatus = { rpcConnectionStatus }
				simulateExecutionReply = { simulateExecutionReply }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				simTx = { simTx }
				activeAddress = { activeAddress }
			/>
		</div>
	</>
}
