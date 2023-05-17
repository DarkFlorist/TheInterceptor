import { useState, useEffect } from 'preact/hooks'
import { ConfirmTransactionDialogState, ConfirmTransactionSimulationBaseData, ConfirmTransactionTransactionSingleVisualizationArray, ExternalPopupMessage, IsConnected } from '../../utils/interceptor-messages.js'
import { SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { ExtraDetailsTransactionCard, GasFee, LogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddingNewAddressType, AddressBookEntry } from '../../utils/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { Error as ErrorComponent, ErrorCheckBox } from '../subcomponents/Error.js'
import { QuarantineCodes, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { TIME_BETWEEN_BLOCKS } from '../../utils/constants.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'

type UnderTransactionsParams = {
	pendingTransactions: ConfirmTransactionTransactionSingleVisualizationArray
}

const HALF_HEADER_HEIGHT = 48 / 2

function UnderTransactions(param: UnderTransactionsParams) {
	const nTx = param.pendingTransactions.length
	return <div style = {`position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;`}>
		{ param.pendingTransactions.map((transactionSimulation, index) => {
			const style = `margin-right: 10px; margin-left: 10px; margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			if (transactionSimulation.statusCode === 'success') {
				const simTx = transactionSimulation.data.simulatedAndVisualizedTransactions.at(-1)
				if (simTx === undefined) throw new Error('No simulated and visualized transactions')
				return <div class = 'card' style = { style }>
					<TransactionHeader simTx = { simTx } />
					<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
				</div>
			}
			return <div class = 'card' style = { style }>
				<TransactionHeaderForFailedToSimulate website = { transactionSimulation.data.transactionToSimulate.website } />
				<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
			</div>
		}) }
	</div>
}

type TransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	pendingTransactions: ConfirmTransactionTransactionSingleVisualizationArray,
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	resetButton: boolean,
	currentBlockNumber: bigint | undefined,
	isConnected: IsConnected,
}

function TransactionCard(param: TransactionCardParams) {
	const simTx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
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

		<UnderTransactions pendingTransactions = { param.pendingTransactions }/>
		<div class = 'card' style = { `margin: 10px; margin-top: 0px; top: ${ param.pendingTransactions.length * -HALF_HEADER_HEIGHT }px` }>
			<TransactionHeader
				simTx = { simTx }
			/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						simTx = { simTx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
					<QuarantineCodes quarantineCodes = { simTx.quarantineCodes }/>
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

				<SenderReceiver
					from = { simTx.transaction.from }
					to = { simTx.transaction.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: 33.33% 33.33% 33.33%;'>
					<div class = 'log-cell'>
						<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content'>
							<GasFee
								tx = { simTx }
								chain = { param.simulationAndVisualisationResults.chain }
							/>
						</span>
					</div>
					<div class = 'log-cell' style = 'justify-content: center;'>
						<TransactionCreated transactionCreated = { simTx.transactionCreated } />
					</div>
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
	const [pendingTransactions, setPendingTransactions] = useState<ConfirmTransactionTransactionSingleVisualizationArray>([])
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [isConnected, setIsConnected] = useState<IsConnected>(undefined)
	const [pendingTransactionAddedNotification, setPendingTransactionAddedNotification] = useState<boolean>(false)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
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
			if (message.method === 'popup_confirm_transaction_dialog_pending_changed') {
				setPendingTransactions(message.data.slice(1))
				const currentWindow = await browser.windows.getCurrent()
				if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
				setPendingTransactionAddedNotification(true)
				browser.windows.update(currentWindow.id, { focused: true })
				return
			}
			if (message.method !== 'popup_update_confirm_transaction_dialog') return
			setPendingTransactions(message.data.slice(1))
			const firstMessage = message.data[0]

			if (firstMessage.statusCode === 'failed') return setDialogState({ state: 'failed', data: firstMessage.data })

			if (currentBlockNumber === undefined || firstMessage.data.simulationState.blockNumber > currentBlockNumber) {
				setCurrentBlockNumber(firstMessage.data.simulationState.blockNumber)
			}
			setSimulatedAndVisualizedTransactions(firstMessage.data.simulatedAndVisualizedTransactions)
			setDialogState({ state: 'success', data: firstMessage.data })
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_confirmTransactionReadyAndListening' }) }, [])

	async function approve() {
		if (dialogState === undefined) throw new Error('dialogState is not set')
		const currentWindow = await browser.windows.getCurrent()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', options: { requestId: dialogState.data.requestId, accept: true, windowId: currentWindow.id } })
	}
	async function reject() {
		if (dialogState === undefined) throw new Error('dialogState is not set')
		const currentWindow = await browser.windows.getCurrent()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', options: { requestId: dialogState.data.requestId, accept: false, windowId: currentWindow.id } })
	}
	const refreshMetadata = () => {
		if (dialogState === undefined || dialogState.state === 'failed') return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata', data: dialogState.data })
	}
	const refreshSimulation = () => {
		if (dialogState === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation', data: dialogState.data })
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
		const tx = simulatedAndVisualizedTransactions.at(-1)
		if (tx === undefined) return <></>
		const identified = identifyTransaction(tx)

		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject} >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right' onClick = { approve } disabled = { isConfirmDisabled() }>
				{ dialogState.data.simulationMode ? `${ identified.simulationAction }!` :
					<SignerLogoText {...{
						signerName: dialogState.data.signerName,
						text: identified.signingAction,
					}}/>
				}
			</button>
		</div>
	}

	if (dialogState === undefined) return <CenterToPageTextSpinner text = 'Simulating...'/>
	if (dialogState.state === 'failed') return <CenterToPageTextSpinner text = 'Failed to simulate. Retrying...'/>

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
						{ isConnected?.isConnected === false ?
							<div style = 'margin: 10px; background-color: var(--bg-color);'>
								<ErrorComponent warning = { true } text = { <>Unable to connect to a Ethereum node. Retrying in <SomeTimeAgo priorTimestamp = { new Date(isConnected.lastConnnectionAttempt + TIME_BETWEEN_BLOCKS * 1000) } countBackwards = { true }/>.</> }/>
							</div>
						: <></> }
						{ pendingTransactionAddedNotification === true ? 
							<DinoSaysNotification
								text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ pendingTransactions.length > 1 ? 's' : '' } to see the new one.` }
								close = { () => setPendingTransactionAddedNotification(false)}
							/>
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
							pendingTransactions = { pendingTransactions }
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
