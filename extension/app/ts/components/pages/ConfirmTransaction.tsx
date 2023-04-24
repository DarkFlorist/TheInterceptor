import { useState, useEffect } from 'preact/hooks'
import { ConfirmTransactionDialogState, ConfirmTransactionSimulationBaseData, ExternalPopupMessage, IsConnected } from '../../utils/interceptor-messages.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { ExtraDetailsTransactionCard, GasFee, LogAnalysisCard, SimulatedInBlockNumber, TransactionHeader, TransactionsAccountChangesCard } from '../simulationExplaining/SimulationSummary.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddingNewAddressType, AddressBookEntry } from '../../utils/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { formSimulatedAndVisualizedTransaction } from '../formVisualizerResults.js'
import { addressString } from '../../utils/bigint.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { Error as ErrorComponent, ErrorCheckBox } from '../subcomponents/Error.js'
import { QuarantineCodes, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'

type TransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	resetButton: boolean,
	currentBlockNumber: bigint | undefined,
	isConnected: IsConnected,
}

function TransactionCard(param: TransactionCardParams) {
	const simTx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1]
	if (simTx === undefined) return <></>

	return <>
		<div class = 'block' style = 'margin: 10px; margin-top: 10px; margin-bottom: 10px;'>
			<nav class = 'breadcrumb has-succeeds-separator is-small'>
				<ul>
					{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map((simTx, index) => (
						<li style = 'margin: 0px;'>
							<div class = 'card' style = { `padding: 5px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
								<p class = 'paragraph' style = {`margin: 0px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
									{ identifyTransaction(simTx).title }
								</p>
							</div>
						</li>
					)) }
				</ul>
			</nav>
		</div>

		<div class = 'card' style = 'margin: 10px;'>
			<TransactionHeader
				simTx = { simTx }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						simTx = { simTx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
					<QuarantineCodes simTx = { simTx }/>
				</div>

				<TransactionsAccountChangesCard
					simTx = { simTx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { param.simulationAndVisualisationResults.addressMetaData }
				/>

				<LogAnalysisCard
					simTx = { simTx }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<ExtraDetailsTransactionCard transaction = { simTx.transaction } />

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: min-content min-content min-content auto;'>
					<GasFee
						tx = { simTx }
						chain = { param.simulationAndVisualisationResults.chain }
					/>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { param.simulationAndVisualisationResults.blockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }
							isConnected = { param.isConnected }
						/>
					</div>
				</span>
			</div>
		</div>
	</>
}

type DialogState = { state: 'success', data: ConfirmTransactionDialogState } | { state: 'failed', data: ConfirmTransactionSimulationBaseData } | undefined

export function ConfirmTransaction() {
	const [dialogState, setDialogState] = useState<DialogState>(undefined)
	const [simulatedAndVisualizedTransactions, setSimulatedAndVisualizedTransactions] = useState<readonly SimulatedAndVisualizedTransaction[]>([])
	const [sender, setSender] = useState<AddressBookEntry | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [isConnected, setIsConnected] = useState<IsConnected>(undefined)

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)

			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method === 'popup_new_block_arrived') {
				setIsConnected({ isConnected: true, lastConnnectionAttempt: Date.now() })
				refreshSimulation()
				return setCurrentBlockNumber(message.data.blockNumber)
			}
			if (message.method === 'popup_failed_to_get_block') {
				setIsConnected({ isConnected: false, lastConnnectionAttempt: Date.now() })
			}
			if (message.method === 'popup_confirm_transaction_simulation_failed') {
				return setDialogState({ state: 'failed', data: message.data })
			}
			if (message.method !== 'popup_confirm_transaction_simulation_state_changed') return

			if (currentBlockNumber === undefined || message.data.simulationState.blockNumber > currentBlockNumber) {
				setCurrentBlockNumber(message.data.simulationState.blockNumber)
			}
			const addressMetaData = new Map(message.data.addressBookEntries.map((x) => [addressString(x.address), x]))
			const txs = formSimulatedAndVisualizedTransaction(message.data.simulationState, message.data.visualizerResults, addressMetaData)
			setTransactionToSimulate(message.data.transactionToSimulate)
			setSender(txs[txs.length - 1]?.transaction.from)
			setSimulatedAndVisualizedTransactions(txs)
			setDialogState({ state: 'success', data: message.data })
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect( () => { sendPopupMessageToBackgroundPage({ method: 'popup_confirmTransactionReadyAndListening' }) }, [])

	async function approve() {
		if (dialogState === undefined) throw new Error('dialogState is not set')
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', options: { requestId: dialogState.data.requestId, accept: true } })
		globalThis.close()
	}
	async function reject() {
		if (dialogState === undefined) throw new Error('dialogState is not set')
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', options: { requestId: dialogState.data.requestId, accept: false } })
		globalThis.close()
	}
	const refreshMetadata = () => {
		if (dialogState === undefined || dialogState.state === 'failed') return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata', data: dialogState.data })
	}
	const refreshSimulation = () => {
		if (dialogState === undefined) return
		sendPopupMessageToBackgroundPage({
			method: 'popup_refreshConfirmTransactionDialogSimulation',
			data: dialogState.data,
		})
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		if (dialogState === undefined) return false
		const lastTx = simulatedAndVisualizedTransactions[simulatedAndVisualizedTransactions.length - 1 ]
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine == false
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function Buttons() {
		if (dialogState === undefined) return <></>
		const tx = simulatedAndVisualizedTransactions[simulatedAndVisualizedTransactions.length - 1]
		if (tx === undefined) return <></>
		const identified = identifyTransaction(tx)

		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow' style = 'flex-grow: 1; margin-left: 10px; margin-right: 5px; margin-top: 0px; margin-bottom: 0px;' onClick = { reject} >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow' style = 'flex-grow: 1; margin-left: 5px; margin-right: 10px; margin-top: 0px; margin-bottom: 0px;' onClick = { approve } disabled = { isConfirmDisabled() }>
				{ dialogState.data.simulationMode ? `${ identified.simulationAction }!` :
					<SignerLogoText {...{
						signerName: dialogState.data.signerName,
						text: identified.signingAction,
					}}/>
				}
			</button>
		</div>
	}

	if (dialogState === undefined) {
		return <main class = 'center-to-page'>
			<div class = 'vertical-center' style = 'scale: 3'>
				<Spinner/>
				<span style = 'margin-left: 0.2em' > Simulating... </span>
			</div>
		</main>
	}

	if (dialogState.state === 'failed') {
		return <main class = 'center-to-page'>
			<div class = 'vertical-center' style = 'scale: 3'>
				<Spinner/>
				<span style = 'margin-left: 0.2em' > Failed to simulate transaction. Retrying... </span>
			</div>
		</main>
	}

	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed' ? <></> :
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addingNewAddress = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
					<div style = 'overflow-y: auto'>
						<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
							<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden; padding: 0px;'>
								<WebsiteOriginText { ...dialogState.data.website } />
							</div>
							<p class = 'card-header-title' style = 'overflow: hidden; font-weight: unset; flex-direction: row-reverse;'>
								{ sender === undefined ? <></> : <SmallAddress
									addressBookEntry = { sender }
									renameAddressCallBack = { renameAddressCallBack }
								/> }
							</p>
						</header>

						{ isConnected?.isConnected === false ?
							<div style = 'margin: 10px; background-color: var(--bg-color);'>
								<ErrorComponent warning = { true } text = { <>Unable to connect to a Ethereum node. Retrying in <SomeTimeAgo priorTimestamp = { new Date(isConnected.lastConnnectionAttempt + TIME_BETWEEN_BLOCKS * 1000) } countBackwards = { true }/>.</> }/>
							</div>
						: <></> }

						<TransactionCard
							simulationAndVisualisationResults = { {
								blockNumber: dialogState.data.simulationState.blockNumber,
								blockTimestamp: dialogState.data.simulationState.blockTimestamp,
								simulationConductedTimestamp: dialogState.data.simulationState.simulationConductedTimestamp,
								addressMetaData: dialogState.data.addressBookEntries,
								chain: dialogState.data.simulationState.chain,
								tokenPrices: dialogState.data.tokenPrices,
								activeAddress: dialogState.data.activeAddress,
								simulatedAndVisualizedTransactions: simulatedAndVisualizedTransactions
							} }
							renameAddressCallBack = { renameAddressCallBack }
							activeAddress = { dialogState.data.activeAddress }
							resetButton = { false }
							currentBlockNumber = { currentBlockNumber }
							isConnected = { isConnected }
						/>
					</div>

					<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
						{ dialogState && simulatedAndVisualizedTransactions[simulatedAndVisualizedTransactions.length - 1 ].statusCode === 'success' ?
							dialogState && simulatedAndVisualizedTransactions[simulatedAndVisualizedTransactions.length - 1 ].quarantine !== true ? <></> :
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
						:
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
						}
						<Buttons/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
