import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { MessageToPopup, GovernanceVoteInputParameters, SimulateGovernanceContractExecutionReply } from '../../../types/interceptor-messages.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from '../../../types/visualizer-types.js'
import { EthereumQuantity } from '../../../types/wire-types.js'
import { checksummedAddress, dataStringWith0xStart } from '../../../utils/bigint.js'
import { BIG_FONT_SIZE } from '../../../utils/constants.js'
import { ErrorComponent } from '../../subcomponents/Error.js'
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
				<button class = { `button is-primary` } onClick = { () => params.addressBookEntry !== undefined && params.renameAddressCallBack(params.addressBookEntry) }>
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
				<p style = { { 'font-size': BIG_FONT_SIZE } } >
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
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	simulateGovernanceContractExecutionReply: SimulateGovernanceContractExecutionReply | undefined
	renameAddressCallBack: RenameAddressCallBack
}

const simulateGovernanceVote = (transactionIdentifier: EthereumQuantity) => sendPopupMessageToBackgroundPage({ method: 'popup_simulateGovernanceContractExecution', data: { transactionIdentifier } })

const ShowSuccessOrFailure = ({ simulateGovernanceContractExecutionReply, simTx, simulationAndVisualisationResults, renameAddressCallBack }: ShowSuccessOrFailureParams) => { 
	const missingAbiText = 'The governance contract is missing an ABI. Add an ABI to simulate execution of this proposal.'
	if (simulateGovernanceContractExecutionReply === undefined) {
		return <div style = 'display: flex; justify-content: center;'>
			{ simTx.transaction.to !== undefined && 'abi' in simTx.transaction.to && simTx.transaction.to.abi !== undefined ?
				<button
					class = { `button is-primary` }
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
	if (simulateGovernanceContractExecutionReply.data.success === false) {
		return <div style = 'display: grid; grid-template-rows: max-content' >
			{ simulateGovernanceContractExecutionReply.data.error.type === 'MissingAbi' ? <MissingAbi
				errorMessage = { missingAbiText }
				addressBookEntry = { simulateGovernanceContractExecutionReply.data.error.addressBookEntry }
				renameAddressCallBack = { renameAddressCallBack }
			/> : <ErrorComponent text = { simulateGovernanceContractExecutionReply.data.error.message }/> }
		</div>
	}
	const govSimTx = simulateGovernanceContractExecutionReply.data.result.simulatedAndVisualizedTransactions.at(-1)
	if (govSimTx === undefined) return <></>
	return <div style = 'display: grid; grid-template-rows: max-content' >
		<Transaction
			simTx = { govSimTx }
			simulationAndVisualisationResults = { {
				blockNumber: simulateGovernanceContractExecutionReply.data.result.simulationState.blockNumber,
				blockTimestamp: simulateGovernanceContractExecutionReply.data.result.simulationState.blockTimestamp,
				simulationConductedTimestamp: simulateGovernanceContractExecutionReply.data.result.simulationState.simulationConductedTimestamp,
				addressBookEntries: simulateGovernanceContractExecutionReply.data.result.addressBookEntries,
				rpcNetwork: simulateGovernanceContractExecutionReply.data.result.simulationState.rpcNetwork,
				tokenPrices: simulateGovernanceContractExecutionReply.data.result.tokenPrices,
				activeAddress: simulationAndVisualisationResults.activeAddress,
				simulatedAndVisualizedTransactions: simulateGovernanceContractExecutionReply.data.result.simulatedAndVisualizedTransactions,
				visualizedPersonalSignRequests: simulateGovernanceContractExecutionReply.data.result.visualizedPersonalSignRequests,
				namedTokenIds: simulateGovernanceContractExecutionReply.data.result.namedTokenIds,
			} }
			removeTransactionOrSignedMessage = { undefined }
			activeAddress = { simulationAndVisualisationResults.activeAddress }
			renameAddressCallBack = { renameAddressCallBack }
			addressMetaData = { simulateGovernanceContractExecutionReply.data.result.addressBookEntries }
		/>
	</div>
}

type GovernanceVoteVisualizerParams = {
	simTx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	renameAddressCallBack: RenameAddressCallBack
	governanceVoteInputParameters: GovernanceVoteInputParameters
}

export function GovernanceVoteVisualizer(param: GovernanceVoteVisualizerParams) {
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [simulateGovernanceContractExecutionReply, setSimulateGovernanceContractExecutionReply] = useState<SimulateGovernanceContractExecutionReply | undefined>(undefined)
	
	const [governanceVoteInputParameters, setGovernanceVoteInputParameters] = useState<GovernanceVoteInputParameters | undefined>(undefined)
	const [simTx, setSimTx] = useState<SimulatedAndVisualizedTransaction | undefined>(undefined)
	const [simulationAndVisualisationResults, setSimulationAndVisualisationResults] = useState<SimulationAndVisualisationResults | undefined>(undefined)

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				return setCurrentBlockNumber(parsed.data.rpcConnectionStatus?.latestBlock?.number)
			}
			if (parsed.method !== 'popup_simulateGovernanceContractExecutionReply') return
			const reply = SimulateGovernanceContractExecutionReply.parse(parsed)
			if (reply.data.transactionIdentifier !== param.simTx.transactionIdentifier) return
			return setSimulateGovernanceContractExecutionReply(SimulateGovernanceContractExecutionReply.parse(parsed))
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => {
		setGovernanceVoteInputParameters(param.governanceVoteInputParameters)
		setSimTx(param.simTx)
		setSimulationAndVisualisationResults(param.simulationAndVisualisationResults)
		setSimulateGovernanceContractExecutionReply(undefined)
	}, [param.simTx.transactionIdentifier])

	if (governanceVoteInputParameters === undefined || simTx === undefined || simulationAndVisualisationResults === undefined) return <></>
	return <>
		<VotePanel inputParams = { governanceVoteInputParameters } />
		
		<div style = 'display: grid; grid-template-rows: max-content max-content'>
			<span class = 'log-table' style = 'padding-bottom: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<p class = 'paragraph'>Simulation of this proposal's outcome should the vote pass:</p>
				</div>
				<div class = 'log-cell' style = 'justify-content: right;'>
					{ simulateGovernanceContractExecutionReply === undefined ? <></> : 
						<button class = { `button is-primary is-small` } onClick = { () => simulateGovernanceVote(simTx.transactionIdentifier) }>Refresh</button>
					}
				</div>
			</span>
		</div>

		<div class = 'notification dashed-notification'>
			<ShowSuccessOrFailure
				currentBlockNumber = { currentBlockNumber }
				rpcConnectionStatus = { rpcConnectionStatus }
				simulateGovernanceContractExecutionReply = { simulateGovernanceContractExecutionReply }
				renameAddressCallBack = { param.renameAddressCallBack }
				simTx = { simTx }
				simulationAndVisualisationResults = { simulationAndVisualisationResults }
			/>
		</div>
	</>
}
