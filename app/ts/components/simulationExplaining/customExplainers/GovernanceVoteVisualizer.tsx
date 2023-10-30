import { sendPopupMessageToBackgroundPage } from '../../../background/backgroundUtils.js'
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
					{ simulateGovernanceContractExecutionReply !== undefined ? <>
						<button
							class = { `button is-primary is-small` }
							onClick = { simulateGovernanceVote }>
							Refresh
						</button>
					</> : <></>}
				</div>
			</span>
		</div>
			<div class = 'notification dashed-notification'>
				<div style = 'display: grid; grid-template-rows: max-content' >
					<div style = 'display: grid; grid-template-rows: max-content max-content' >
						{ simulateGovernanceContractExecutionReply !== undefined ? <>
							{ 'error' in simulateGovernanceContractExecutionReply.data ? <ErrorComponent warning = { false } text = { simulateGovernanceContractExecutionReply.data.error.message }/> : <>
								<GovernanceTransactionExecution
									simulationAndVisualisationResults = { {
										blockNumber: simulateGovernanceContractExecutionReply.data.simulationState.blockNumber,
										blockTimestamp: simulateGovernanceContractExecutionReply.data.simulationState.blockTimestamp,
										simulationConductedTimestamp: simulateGovernanceContractExecutionReply.data.simulationState.simulationConductedTimestamp,
										addressBookEntries: simulateGovernanceContractExecutionReply.data.addressBookEntries,
										rpcNetwork: simulateGovernanceContractExecutionReply.data.simulationState.rpcNetwork,
										tokenPrices: simulateGovernanceContractExecutionReply.data.tokenPrices,
										activeAddress: param.simulationAndVisualisationResults.activeAddress,
										simulatedAndVisualizedTransactions: simulateGovernanceContractExecutionReply.data.simulatedAndVisualizedTransactions,
										visualizedPersonalSignRequests: simulateGovernanceContractExecutionReply.data.visualizedPersonalSignRequests,
										namedTokenIds: simulateGovernanceContractExecutionReply.data.namedTokenIds,
									} }
									pendingTransactions = { [] }
									renameAddressCallBack = { param.renameAddressCallBack }
									activeAddress = { param.simulationAndVisualisationResults.activeAddress }
									resetButton = { false }
									currentBlockNumber = { currentBlockNumber }
									rpcConnectionStatus = { rpcConnectionStatus }
								/>
							</> }
						</> : <>
							{ !(param.simulationAndVisualisationResults.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' // todo remove this check
								|| param.simulationAndVisualisationResults.rpcNetwork.httpsRpc=== 'https://rpc.dark.florist/winedancemuffinborrow') ? <p class = 'paragraph'> experimental rpc client required </p> : <></> }
								<button
									class = { `button is-primary` }
									onClick = { simulateGovernanceVote }
									disabled = { !(param.simulationAndVisualisationResults.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' // todo remove this check
											|| param.simulationAndVisualisationResults.rpcNetwork.httpsRpc=== 'https://rpc.dark.florist/winedancemuffinborrow')
									}>
									Simulate execution on a passing vote
								</button>
							</>
						}
					</div>
				</div>
			</div>
	</>
}
