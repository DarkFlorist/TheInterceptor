import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
import { AddressBookEntry } from '../../../types/addressBookTypes.js'
import { ExternalPopupMessage, SimulateGovernanceContractExecutionReply } from '../../../types/interceptor-messages.js'
import { RpcConnectionStatus } from '../../../types/user-interface-types.js'
import { TransactionCardParams } from '../../pages/ConfirmTransaction.js'
import { Error as ErrorComponent } from '../../subcomponents/Error.js'
import { TransactionImportanceBlockParams, Transaction } from '../Transactions.js'
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

export function GovernanceVoteVisualizer(param: TransactionImportanceBlockParams) {
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
		<div class = 'notification transaction-importance-box'>
			<div style = 'display: grid; grid-template-rows: max-content max-content' >
				<p> This transaction performs a vote on governance contract</p>
			</div>
		</div>
		
		<div style = 'display: grid; grid-template-rows: max-content max-content'>
			<span class = 'log-table' style = 'padding-bottom: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<p class = 'paragraph'>Simulation of governance votes outcome on a passing vote:</p>
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
