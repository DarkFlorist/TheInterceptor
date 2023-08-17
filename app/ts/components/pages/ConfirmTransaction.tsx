import { useState, useEffect } from 'preact/hooks'
import { ExternalPopupMessage, PendingTransaction, RpcConnectionStatus } from '../../utils/interceptor-messages.js'
import { SimulationAndVisualisationResults } from '../../utils/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { RawTransactionDetailsCard, GasFee, LogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddingNewAddressType, AddressBookEntry } from '../../utils/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { ErrorCheckBox } from '../subcomponents/Error.js'
import { QuarantineCodes, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { NetworkErrors } from './Home.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'

type UnderTransactionsParams = {
	pendingTransactions: PendingTransaction[]
}

const HALF_HEADER_HEIGHT = 48 / 2

function UnderTransactions(param: UnderTransactionsParams) {
	const nTx = param.pendingTransactions.length
	return <div style = {`position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;`}>
		{ param.pendingTransactions.map((pendingTransaction, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			if (pendingTransaction.transactionToSimulate.error !== undefined) return <p>{ pendingTransaction.transactionToSimulate.error.message }</p>
			if (pendingTransaction.simulationResults.statusCode === 'success') {
				const simTx = pendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions.at(-1)
				if (simTx === undefined) throw new Error('No simulated and visualized transactions')
				return <div class = 'card' style = { style }>
					<TransactionHeader simTx = { simTx } />
					<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
				</div>
			}
			return <div class = 'card' style = { style }>
				<TransactionHeaderForFailedToSimulate website = { pendingTransaction.transactionToSimulate.website } />
				<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
			</div>
		}) }
	</div>
}

type TransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	pendingTransactions: PendingTransaction[],
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	resetButton: boolean,
	currentBlockNumber: bigint | undefined,
	rpcConnectionStatus: RpcConnectionStatus,
}

function TransactionCard(param: TransactionCardParams) {
	const simTx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
	if (simTx === undefined) return <></>

	return <>
		<div class = 'block' style = 'margin-bottom: 10px;'>
			<nav class = 'breadcrumb has-succeeds-separator is-small'>
				<ul>
					{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map((simTx, index) => (
						<li style = 'margin: 0px;'>
							<div class = 'card' style = { `padding: 5px; margin: 5px; ${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
								<p class = 'paragraph' style = {`margin: 0px; ${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
									{ identifyTransaction(simTx).title }
								</p>
							</div>
						</li>
					)) }
				</ul>
			</nav>
		</div>

		<UnderTransactions pendingTransactions = { param.pendingTransactions }/>
		<div class = 'card' style = { `top: ${ param.pendingTransactions.length * -HALF_HEADER_HEIGHT }px` }>
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
					addressMetaData = { param.simulationAndVisualisationResults.addressBookEntries }
				/>

				<LogAnalysisCard
					simTx = { simTx }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<RawTransactionDetailsCard transaction = { simTx.transaction } renameAddressCallBack = { param.renameAddressCallBack } gasSpent = { simTx.gasSpent }/>

				<SenderReceiver
					from = { simTx.transaction.from }
					to = { simTx.transaction.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: 33.33% 33.33% 33.33%;'>
					<div class = 'log-cell'>
						<span class = 'log-table' style = 'grid-template-columns: min-content min-content min-content'>
							<GasFee tx = { simTx } rpcNetwork = { param.simulationAndVisualisationResults.rpcNetwork } />
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
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					</div>
				</span>
			</div>
		</div>
	</>
}

export function ConfirmTransaction() {
	const [currentPendingTransaction, setCurrentPendingTransaction] = useState<PendingTransaction | undefined>(undefined)
	const [pendingTransactions, setPendingTransactions] = useState<PendingTransaction[]>([])
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [pendingTransactionAddedNotification, setPendingTransactionAddedNotification] = useState<boolean>(false)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)

			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(message.data.rpcConnectionStatus)
				refreshSimulation()
				return setCurrentBlockNumber(message.data.rpcConnectionStatus?.latestBlock?.number)
			}
			if (message.method === 'popup_failed_to_get_block') {
				setRpcConnectionStatus(message.data.rpcConnectionStatus)
			}
			if (message.method === 'popup_confirm_transaction_dialog_pending_changed') {
				setPendingTransactions(message.data.slice(1).reverse())
				const currentWindowId = (await browser.windows.getCurrent()).id
				const currentTabId = (await browser.tabs.getCurrent()).id
				if (currentWindowId === undefined) throw new Error('could not get current window Id!')
				if (currentTabId === undefined) throw new Error('could not get current tab Id!')
				setPendingTransactionAddedNotification(true)
				browser.windows.update(currentWindowId, { focused: true })
				browser.tabs.update(currentTabId, { active: true })
				return
			}
			if (message.method !== 'popup_update_confirm_transaction_dialog') return
			setPendingTransactions(message.data.slice(1).reverse())
			const firstMessage = message.data[0]
			setCurrentPendingTransaction(firstMessage)
			if (firstMessage.simulationResults !== undefined && firstMessage.simulationResults.statusCode === 'success' && (currentBlockNumber === undefined || firstMessage.simulationResults.data.simulationState.blockNumber > currentBlockNumber)) {
				setCurrentBlockNumber(firstMessage.simulationResults.data.simulationState.blockNumber)
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_confirmTransactionReadyAndListening' }) }, [])

	async function approve() {
		if (currentPendingTransaction === undefined) throw new Error('dialogState is not set')
		setPendingTransactionAddedNotification(false)
		const currentWindow = await browser.windows.getCurrent()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactions.length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransaction.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransaction.request.uniqueRequestIdentifier, accept: true, windowId: currentWindow.id } })
	}
	async function reject() {
		if (currentPendingTransaction === undefined) throw new Error('dialogState is not set')
		setPendingTransactionAddedNotification(false)
		const currentWindow = await browser.windows.getCurrent()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactions.length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransaction.request.uniqueRequestIdentifier.requestSocket.tabId })
		
		const getPossibleErrorString = () => {
			if (currentPendingTransaction.transactionToSimulate.error !== undefined) return currentPendingTransaction.transactionToSimulate.error.message
			if (currentPendingTransaction.simulationResults.statusCode !== 'success' ) return undefined
			const lastTx = currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions.at(-1)
			if (lastTx === undefined) return undefined
			return lastTx.statusCode === 'failure' ? lastTx.error : undefined
		}
		
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransaction.request.uniqueRequestIdentifier,
			accept: false,
			windowId: currentWindow.id,
			transactionErrorString: getPossibleErrorString(),
		} })
	}
	const refreshMetadata = () => {
		// todo we should refresh metadata even if the resuls are failures
		if (currentPendingTransaction === undefined || currentPendingTransaction.simulationResults === undefined || currentPendingTransaction.simulationResults.statusCode === 'failed') return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata', data: currentPendingTransaction.simulationResults.data })
	}
	const refreshSimulation = () => {
		if (currentPendingTransaction === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation', data: {
			uniqueRequestIdentifier: currentPendingTransaction.request.uniqueRequestIdentifier,
			activeAddress: currentPendingTransaction.activeAddress,
			simulationMode: currentPendingTransaction.simulationMode,
			originalTransactionRequestParameters: currentPendingTransaction.transactionToSimulate.originalTransactionRequestParameters,
			website: currentPendingTransaction.transactionToSimulate.website,
			transactionCreated: currentPendingTransaction.transactionCreated,
		} })
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		if (currentPendingTransaction === undefined) return false
		if (currentPendingTransaction.simulationResults === undefined) return false
		if (currentPendingTransaction.simulationResults.statusCode !== 'success' ) return false
		const lastTx = currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions.at(-1)
		if (lastTx === undefined ) return false
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine == false
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	function Buttons() {
		const lastTx = currentPendingTransaction === undefined || currentPendingTransaction.simulationResults.statusCode !== 'success'
			? undefined : currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions.at(-1)
		if (lastTx === undefined || currentPendingTransaction === undefined || currentPendingTransaction.transactionToSimulate.error !== undefined) {
			return <div style = 'display: flex; flex-direction: row;'>
				<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
					{ 'Reject failing transaction' }
				</button>
			</div>
		}
		const identified = identifyTransaction(lastTx)

		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right' onClick = { approve } disabled = { isConfirmDisabled() }>
				{ currentPendingTransaction.simulationMode
					? `${ identified.simulationAction }!`
					: <SignerLogoText {...{
						signerName: currentPendingTransaction.simulationResults.data.signerName,
						text: identified.signingAction,
					}}/>
				}
			</button>
		</div>
	}

	if (currentPendingTransaction === undefined) return <CenterToPageTextSpinner text = 'Simulating...'/>
	const simulationResults = currentPendingTransaction.simulationResults
	if (simulationResults.statusCode === 'failed') return <CenterToPageTextSpinner text = 'Failed to simulate. Retrying...'/>

	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed'
						? <></>
						: <AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addingNewAddress = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div class = 'block popup-block'>
					<div class = 'popup-block-scroll'>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>

						{ currentPendingTransaction.transactionToSimulate.originalTransactionRequestParameters.method === 'eth_sendRawTransaction'
							? <DinoSaysNotification
								text = { `This transaction is signed already. No extra signing required to forward it to ${ simulationResults === undefined ? 'network' : simulationResults.data.simulationState.rpcNetwork.name }.` }
								close = { () => setPendingTransactionAddedNotification(false)}
							/>
							: <></>
						}
						{ pendingTransactionAddedNotification === true
							? <DinoSaysNotification
								text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ pendingTransactions.length > 1 ? 's' : '' } to see the new one.` }
								close = { () => setPendingTransactionAddedNotification(false)}
							/>
							: <></>
						}
						{ currentPendingTransaction.transactionToSimulate.error !== undefined ? <>
							<DinoSaysNotification
								text = { `Hey! We were unable to calculate gas limit for this transaction. The transaction fails to execute.` }
								close = { () => setPendingTransactionAddedNotification(false)}
							/>
						</> : <> </>}
						
						<TransactionCard
							simulationAndVisualisationResults = { {
								blockNumber: simulationResults.data.simulationState.blockNumber,
								blockTimestamp: simulationResults.data.simulationState.blockTimestamp,
								simulationConductedTimestamp: simulationResults.data.simulationState.simulationConductedTimestamp,
								addressBookEntries: simulationResults.data.addressBookEntries,
								rpcNetwork: simulationResults.data.simulationState.rpcNetwork,
								tokenPrices: simulationResults.data.tokenPrices,
								activeAddress: simulationResults.data.activeAddress,
								simulatedAndVisualizedTransactions: simulationResults.data.simulatedAndVisualizedTransactions
							} }
							pendingTransactions = { pendingTransactions }
							renameAddressCallBack = { renameAddressCallBack }
							activeAddress = { currentPendingTransaction.activeAddress }
							resetButton = { false }
							currentBlockNumber = { currentBlockNumber }
							rpcConnectionStatus = { rpcConnectionStatus }
						/>
					</div>

					<nav class = 'window-header popup-button-row'>
						{ simulationResults.data.transactionToSimulate.error === undefined ? 
							simulationResults.data.simulatedAndVisualizedTransactions.at(-1)?.statusCode === 'success'
								? simulationResults.data.simulatedAndVisualizedTransactions.at(-1)?.quarantine !== true
									? <></>
									: <div style = 'display: grid'>
										<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
											<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
										</div>
									</div>
								: <div style = 'display: grid'>
									<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
										<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { forceSend } onInput = { setForceSend } />
									</div>
								</div>
						: <></> }
						<Buttons/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
