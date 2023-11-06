import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { ExternalPopupMessage, GovernanceVoteInputParameters, SimulateGovernanceContractExecutionReply } from '../../../types/interceptor-messages.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../../types/user-interface-types.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from '../../../types/visualizer-types.js'
import { checksummedAddress, dataStringWith0xStart } from '../../../utils/bigint.js'
import { BIG_FONT_SIZE } from '../../../utils/constants.js'
import { TransactionCardParams } from '../../pages/ConfirmTransaction.js'
import { Error as ErrorComponent } from '../../subcomponents/Error.js'
import { CellElement } from '../../ui-utils.js'
import { Transaction } from '../Transactions.js'
import { useEffect, useState } from 'preact/hooks'

export function GovernanceTransactionExecution(param: TransactionCardParams) {
	const simTx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
	if (simTx === undefined) throw new Error('missing transation')
	return <>
		<Transaction
			simTx = { simTx }
			simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
			removeTransaction = { undefined }
			activeAddress = { param.activeAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
	</>
}

export type MissingAbiParams = {
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


export function VotePanel({ inputParams }: { inputParams: GovernanceVoteInputParameters }) {
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
						<CellElement text = 'Params: '/>
						<CellElement text = { dataStringWith0xStart(inputParams.params) } />
					</> : <></> }
				</span>
			</div>
		</> : <></> }
	</>
}

export type GovernanceVoteVisualizerParams = {
	simTx: SimulatedAndVisualizedTransaction
    simulationAndVisualisationResults: SimulationAndVisualisationResults
    renameAddressCallBack: RenameAddressCallBack
	governanceVoteInputParameters: GovernanceVoteInputParameters
}

export function GovernanceVoteVisualizer(param: GovernanceVoteVisualizerParams) {
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [simulateGovernanceContractExecutionReply, setSimulateGovernanceContractExecutionReply] = useState<SimulateGovernanceContractExecutionReply | undefined>(undefined)
	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(message.data.rpcConnectionStatus)
				return setCurrentBlockNumber(message.data.rpcConnectionStatus?.latestBlock?.number)
			}
			if (message.method !== 'popup_simulateGovernanceContractExecutionReply') return
			return setSimulateGovernanceContractExecutionReply(SimulateGovernanceContractExecutionReply.parse(message))
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	function simulateGovernanceVote() {
		sendPopupMessageToBackgroundPage({ method: 'popup_simulateGovernanceContractExecution' })
	}

	const [MaybeRefreshButton_] = useState(() => () => simulateGovernanceContractExecutionReply !== undefined ? <button class = { `button is-primary is-small` } onClick = { simulateGovernanceVote }>Refresh</button> : <></>)

	const [ShowSuccessOrFailure_] = useState(() => () => {
		const missingAbiText = 'The governance contract is missing an ABI. Add an ABI to simulate execution of this proposal.'
		if (simulateGovernanceContractExecutionReply === undefined) {
			return <div style = 'display: flex; justify-content: center;'>
				{ !(param.simulationAndVisualisationResults.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' // todo remove this check
					|| param.simulationAndVisualisationResults.rpcNetwork.httpsRpc=== 'https://rpc.dark.florist/winedancemuffinborrow') ? <p class = 'paragraph'> experimental rpc client required </p> : <></> }
					
				{ param.simTx.transaction.to !== undefined && 'abi' in param.simTx.transaction.to && param.simTx.transaction.to.abi !== undefined ?
					<button
						class = { `button is-primary` }
						onClick = { simulateGovernanceVote }
						disabled = { !(param.simulationAndVisualisationResults.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' // todo remove this check
								|| param.simulationAndVisualisationResults.rpcNetwork.httpsRpc=== 'https://rpc.dark.florist/winedancemuffinborrow')
					}>
						Simulate execution on a passing vote
					</button>
				: <> <MissingAbi
						errorMessage = { missingAbiText }
						addressBookEntry = { param.simTx.transaction.to }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</> }
			</div>
		}
		if (simulateGovernanceContractExecutionReply.data.success == false) {
			return <div style = 'display: grid; grid-template-rows: max-content' >
				{ simulateGovernanceContractExecutionReply.data.error.type === 'MissingAbi' ? <MissingAbi
					errorMessage = { missingAbiText }
					addressBookEntry = { simulateGovernanceContractExecutionReply.data.error.addressBookEntry }
					renameAddressCallBack = { param.renameAddressCallBack }
				/> : <ErrorComponent warning = { false } text = { simulateGovernanceContractExecutionReply.data.error.message }/> }
			</div>
		}
		return <div style = 'display: grid; grid-template-rows: max-content' >
			<GovernanceTransactionExecution
				simulationAndVisualisationResults = { {
					blockNumber: simulateGovernanceContractExecutionReply.data.result.simulationState.blockNumber,
					blockTimestamp: simulateGovernanceContractExecutionReply.data.result.simulationState.blockTimestamp,
					simulationConductedTimestamp: simulateGovernanceContractExecutionReply.data.result.simulationState.simulationConductedTimestamp,
					addressBookEntries: simulateGovernanceContractExecutionReply.data.result.addressBookEntries,
					rpcNetwork: simulateGovernanceContractExecutionReply.data.result.simulationState.rpcNetwork,
					tokenPrices: simulateGovernanceContractExecutionReply.data.result.tokenPrices,
					activeAddress: param.simulationAndVisualisationResults.activeAddress,
					simulatedAndVisualizedTransactions: simulateGovernanceContractExecutionReply.data.result.simulatedAndVisualizedTransactions,
					visualizedPersonalSignRequests: simulateGovernanceContractExecutionReply.data.result.visualizedPersonalSignRequests,
					namedTokenIds: simulateGovernanceContractExecutionReply.data.result.namedTokenIds,
				} }
				pendingTransactions = { [] }
				renameAddressCallBack = { param.renameAddressCallBack }
				activeAddress = { param.simulationAndVisualisationResults.activeAddress }
				resetButton = { false }
				currentBlockNumber = { currentBlockNumber }
				rpcConnectionStatus = { rpcConnectionStatus }
			/>
		</div>
	})

	return <>
		<VotePanel inputParams = { param.governanceVoteInputParameters } />
		
		<div style = 'display: grid; grid-template-rows: max-content max-content'>
			<span class = 'log-table' style = 'padding-bottom: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<p class = 'paragraph'>Simulation of vote's outcome on a passing vote:</p>
				</div>
				<div class = 'log-cell' style = 'justify-content: right;'>
					<MaybeRefreshButton_/>
				</div>
			</span>
		</div>

		<div class = 'notification dashed-notification'>
			<ShowSuccessOrFailure_/>
		</div>
	</>
}
