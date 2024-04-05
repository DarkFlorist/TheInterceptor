import { useState, useEffect } from 'preact/hooks'
import { MessageToPopup, UpdateConfirmTransactionDialog } from '../../types/interceptor-messages.js'
import { CompleteVisualizedSimulation, ModifyAddressWindowState, SimulatedAndVisualizedTransaction } from '../../types/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard, NonTokenLogAnalysisCard } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner, Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { RpcConnectionStatus } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { ErrorCheckBox, UnexpectedError } from '../subcomponents/Error.js'
import { QuarantineReasons, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import { addressString, checksummedAddress, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../../types/accessRequest.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { serialize } from '../../types/wire-types.js'
import { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { getWebsiteWarningMessage } from '../../utils/websiteData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { WebsiteSocket, checkAndThrowRuntimeLastError, updateTabIfExists, updateWindowIfExists } from '../../utils/requests.js'
import { Link } from '../subcomponents/link.js'
import { NetworkErrors } from '../App.js'
import { SignatureCard, SignatureHeader, identifySignature, isPossibleToSignMessage } from './PersonalSign.js'
import { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'

type UnderTransactionsParams = {
	pendingTransactionsAndSignableMessages: PendingTransactionOrSignableMessage[]
}

const getResultsForTransaction = (results: readonly SimulatedAndVisualizedTransaction[], transactionIdentifier: bigint) => {
	return results.find((result) => result.transactionIdentifier === transactionIdentifier)
}

const HALF_HEADER_HEIGHT = 48 / 2

function UnderTransactions(param: UnderTransactionsParams) {
	const absoluteStyle = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'
	const nTx = param.pendingTransactionsAndSignableMessages.length
	return <div style = { `position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;` }>
		{ param.pendingTransactionsAndSignableMessages.map((pendingTransaction, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return <div class = 'card' style = { style }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? '../img/error-icon.svg' : <Spinner height = '2em'/> }
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? pendingTransaction.transactionToSimulate.error.message : 'Simulating...' }
					</p>
					<p class = 'card-header-icon unsetcursor' style = { 'margin-left: auto; margin-right: 0; overflow: hidden;' }>
						<WebsiteOriginText { ...pendingTransaction.website } />
					</p>
				</header>
				<div style = { absoluteStyle }></div>
			</div>
			if (pendingTransaction.type === 'Transaction') {
				if (pendingTransaction.simulationResults.statusCode === 'success') {
					const simTx = getResultsForTransaction(pendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions, pendingTransaction.transactionIdentifier)
					if (simTx === undefined) throw new Error('No simulated and visualized transactions')
					return <div class = 'card' style = { style }>
						<TransactionHeader simTx = { simTx } />
						<div style = { absoluteStyle }></div>
					</div>
				}
				return <div class = 'card' style = { style }>
					<TransactionHeaderForFailedToSimulate website = { pendingTransaction.transactionToSimulate.website } />
					<div style = { absoluteStyle }></div>
				</div>
			}
			return <div class = 'card' style = { style }>
				<SignatureHeader visualizedPersonalSignRequest = { pendingTransaction.visualizedPersonalSignRequest }/>
				<div style = { absoluteStyle }></div>
			</div>
		}) }
	</div>
}

type TransactionNamesParams = {
	completeVisualizedSimulation: CompleteVisualizedSimulation | undefined
	currentPendingTransaction: PendingTransactionOrSignableMessage
}
const TransactionNames = (param: TransactionNamesParams) => {
	if (param.completeVisualizedSimulation === undefined || param.completeVisualizedSimulation.simulationResultState !== 'done') return <></>
	const transactionsAndMessages: readonly (VisualizedPersonalSignRequest | SimulatedAndVisualizedTransaction)[] = [...param.completeVisualizedSimulation.visualizedPersonalSignRequests, ...param.completeVisualizedSimulation.simulatedAndVisualizedTransactions].sort((n1, n2) => n1.created.getTime() - n2.created.getTime())
	const names = transactionsAndMessages.map((transactionOrMessage) => 'transaction' in transactionOrMessage ? identifyTransaction(transactionOrMessage).title : identifySignature(transactionOrMessage).title)

	const titleOfCurrentPendingTransaction = () => {
		const currentPendingTransactionOrSignableMessage = param.currentPendingTransaction
		if (currentPendingTransactionOrSignableMessage === undefined) return 'Loading...'
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus
		currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest).title
		if (currentPendingTransactionOrSignableMessage.simulationResults.statusCode === 'failed') return 'Failing transaction'
		const lastTx = currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success' ? undefined : getResultsForTransaction(currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransactionOrSignableMessage.transactionIdentifier)
		if (lastTx === undefined) return 'Could not find transaction...'
		return identifyTransaction(lastTx).title
	}
	
	const namesWithCurrentTransaction = [ ...names, titleOfCurrentPendingTransaction() ]
	return <div class = 'block' style = 'margin-bottom: 10px;'>
		<nav class = 'breadcrumb has-succeeds-separator is-small'>
			<ul>
				{ namesWithCurrentTransaction.map((name, index) => (
					<li style = 'margin: 0px;'>
						<div class = 'card' style = { `padding: 5px; margin: 5px; ${ index !== namesWithCurrentTransaction.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
							<p class = 'paragraph' style = { `margin: 0px; ${ index !== namesWithCurrentTransaction.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
								{ name }
							</p>
						</div>
					</li>
				)) }
			</ul>
		</nav>
	</div>
}

type TransactionCardParams = {
	currentPendingTransaction: SimulatedPendingTransaction,
	pendingTransactionsAndSignableMessages: readonly PendingTransactionOrSignableMessage[],
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	currentBlockNumber: bigint | undefined,
	rpcConnectionStatus: RpcConnectionStatus,
	numberOfUnderTransactions: number,
}

function TransactionCard(param: TransactionCardParams) {
	const simulationResults = param.currentPendingTransaction.simulationResults
	const getErrorMesssage = () => {
		if (simulationResults.statusCode === 'failed') return simulationResults.data.error.decodedErrorMessage
		if (!simulationResults.data.transactionToSimulate.success) return simulationResults.data.transactionToSimulate.error.message
		return 'Unknown error'
	}
	if (simulationResults.statusCode === 'failed' || simulationResults.data.transactionToSimulate.success === false) {
		return <>
			<div class = 'card' style = { `top: ${ param.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							<img src = { '../img/error-icon.svg' } />
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ simulationResults.data.transactionToSimulate.success ? 'Gas estimation error' : 'Execution error' }
					</p>
					<p class = 'card-header-icon unsetcursor' style = { 'margin-left: auto; margin-right: 0; overflow: hidden;' }>
						<WebsiteOriginText { ...param.currentPendingTransaction.transactionToSimulate.website } />
					</p>
				</header>
			
				<div class = 'card-content' style = 'padding-bottom: 5px;'>
					<div class = 'container'>
						<ErrorComponent text = { `The transaction fails with an error '${ getErrorMesssage() }'` } />
					</div>
					
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ stringifyJSONWithBigInts(serialize(OriginalSendRequestParameters, param.currentPendingTransaction.originalRequestParameters), 4) }</p>
					</div>
					<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: 33.33% 33.33% 33.33%;'>
						<div class = 'log-cell'>
						</div>
						<div class = 'log-cell' style = 'justify-content: center;'>
							<TransactionCreated created = { param.currentPendingTransaction.created } />
						</div>
						<div class = 'log-cell' style = 'justify-content: right;'>
							<SimulatedInBlockNumber
								simulationBlockNumber = { simulationResults.data.simulationState.blockNumber }
								currentBlockNumber = { param.currentBlockNumber }
								simulationConductedTimestamp = { simulationResults.data.simulationState.simulationConductedTimestamp }
								rpcConnectionStatus = { param.rpcConnectionStatus }
							/>
						</div>
					</span>
				</div>
			</div>
		</>
	}
	const simulationAndVisualisationResults = {
		blockNumber: simulationResults.data.simulationState.blockNumber,
		blockTimestamp: simulationResults.data.simulationState.blockTimestamp,
		simulationConductedTimestamp: simulationResults.data.simulationState.simulationConductedTimestamp,
		addressBookEntries: simulationResults.data.addressBookEntries,
		rpcNetwork: simulationResults.data.simulationState.rpcNetwork,
		tokenPrices: simulationResults.data.tokenPrices,
		activeAddress: simulationResults.data.activeAddress,
		simulatedAndVisualizedTransactions: simulationResults.data.simulatedAndVisualizedTransactions,
		visualizedPersonalSignRequests: simulationResults.data.visualizedPersonalSignRequests,
		namedTokenIds: simulationResults.data.namedTokenIds,
	}

	const simTx = getResultsForTransaction(simulationResults.data.simulatedAndVisualizedTransactions, param.currentPendingTransaction.transactionIdentifier)
	if (simTx === undefined) return <p> Unable to find simulation results for the transaction</p>
	return <>
		<div class = 'card' style = { `top: ${ param.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
			<TransactionHeader simTx = { simTx } />
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						simTx = { simTx }
						activeAddress = { simulationAndVisualisationResults.activeAddress }
						rpcNetwork = { simulationAndVisualisationResults.rpcNetwork }
						renameAddressCallBack = { param.renameAddressCallBack }
						addressMetadata = { simulationAndVisualisationResults.addressBookEntries }
					/>
				</div>
				<QuarantineReasons quarantineReasons = { simTx.quarantineReasons }/>

				<TransactionsAccountChangesCard
					simTx = { simTx }
					simulationAndVisualisationResults = { simulationAndVisualisationResults }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { simulationAndVisualisationResults.addressBookEntries }
					namedTokenIds = { simulationAndVisualisationResults.namedTokenIds }
				/>

				<TokenLogAnalysisCard simTx = { simTx } renameAddressCallBack = { param.renameAddressCallBack } />

				<NonTokenLogAnalysisCard
					simTx = { simTx }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { simulationAndVisualisationResults.addressBookEntries }
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
							<GasFee tx = { simTx } rpcNetwork = { simulationAndVisualisationResults.rpcNetwork } />
						</span>
					</div>
					<div class = 'log-cell' style = 'justify-content: center;'>
						<TransactionCreated created = { param.currentPendingTransaction.created } />
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { simulationAndVisualisationResults.blockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { simulationAndVisualisationResults.simulationConductedTimestamp }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					</div>
				</span>
			</div>
		</div>
	</>
}

type CheckBoxesParams = {
	currentPendingTransactionOrSignableMessage: PendingTransactionOrSignableMessage,
	forceSend: boolean,
	setForceSend: (enabled: boolean) => void,
}
const CheckBoxes = (params: CheckBoxesParams) => {
	if (params.currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	if (params.currentPendingTransactionOrSignableMessage.type === 'SignableMessage') {
		const visualizedPersonalSignRequest = params.currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest
		return  <>
			{ isPossibleToSignMessage(visualizedPersonalSignRequest, visualizedPersonalSignRequest.activeAddress.address) && visualizedPersonalSignRequest.quarantine
				? <div style = 'display: grid'>
					<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
						<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend } onInput = { params.setForceSend } />
					</div>
				</div>
				: <></>
			}
		</>
	}
	if (params.currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success') return <></>
	const simulatedAndVisualizedTransactions = params.currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions
	const currentResults = getResultsForTransaction(simulatedAndVisualizedTransactions, params.currentPendingTransactionOrSignableMessage.transactionIdentifier)
	
	const margins = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px;'
	if (currentResults === undefined) return <></>
	if (params.currentPendingTransactionOrSignableMessage?.approvalStatus.status === 'SignerError') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorComponent text = { params.currentPendingTransactionOrSignableMessage.approvalStatus.message } />
		</div>
	</div>
	if (currentResults.statusCode !== 'success') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { params.forceSend } onInput = { params.setForceSend } />
		</div>
	</div>
	if (currentResults.quarantine === true ) return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend } onInput = { params.setForceSend } />
		</div>
	</div>
	return <></>
}

type NetworkErrorParams = {
	websiteSocket: WebsiteSocket
	website: Website
	simulationMode: boolean
}

const WebsiteErrors = ({ website, websiteSocket, simulationMode }: NetworkErrorParams) => {
	const message = getWebsiteWarningMessage(website.websiteOrigin, simulationMode)
	if (message === undefined) return <></>
	if (message.suggestedAlternative === undefined) return <ErrorComponent warning = { true } text = { message.message }/>
	return <ErrorComponent warning = { true } text = { <> { message.message } <Link url = { message.suggestedAlternative } text = { 'Suggested alternative' } websiteSocket = { websiteSocket } /> </> }/>
}

export function ConfirmTransaction() {
	const [currentPendingTransactionOrSignableMessage, setCurrentPendingTransactionOrSignableMessage] = useState<PendingTransactionOrSignableMessage | undefined>(undefined)
	const [pendingTransactionsAndSignableMessages, setPendingTransactionsAndSignableMessages] = useState<readonly PendingTransactionOrSignableMessage[]>([])
	const [completeVisualizedSimulation, setCompleteVisualizedSimulation] = useState<CompleteVisualizedSimulation |undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<ModifyAddressWindowState | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [pendingTransactionAddedNotification, setPendingTransactionAddedNotification] = useState<boolean>(false)
	const [unexpectedError, setUnexpectedError] = useState<string | undefined>(undefined)

	const updatePendingTransactionsAndSignableMessages = (message: UpdateConfirmTransactionDialog) => {
		setPendingTransactionsAndSignableMessages(message.data.pendingTransactionAndSignableMessages)
		setCompleteVisualizedSimulation(message.data.visualizedSimulatorState)
		setCurrentBlockNumber(message.data.currentBlockNumber)
		const firstMessage = message.data.pendingTransactionAndSignableMessages[0]
		if (firstMessage === undefined) throw new Error('message data was undefined')
		setCurrentPendingTransactionOrSignableMessage(firstMessage)
		if (firstMessage.type === 'Transaction' && (firstMessage.transactionOrMessageCreationStatus === 'Simulated' || firstMessage.transactionOrMessageCreationStatus === 'FailedToSimulate') && firstMessage.simulationResults !== undefined && firstMessage.simulationResults.statusCode === 'success' && (currentBlockNumber === undefined || firstMessage.simulationResults.data.simulationState.blockNumber > currentBlockNumber)) {
			setCurrentBlockNumber(firstMessage.simulationResults.data.simulationState.blockNumber)
		}
	}
	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_UnexpectedErrorOccured') return setUnexpectedError(parsed.data.message)
			if (parsed.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (parsed.method === 'popup_new_block_arrived') {
				setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
				refreshSimulation()
				return setCurrentBlockNumber(parsed.data.rpcConnectionStatus?.latestBlock?.number)
			}
			if (parsed.method === 'popup_failed_to_get_block') {
				return setRpcConnectionStatus(parsed.data.rpcConnectionStatus)
			}
			if (parsed.method === 'popup_confirm_transaction_dialog_pending_changed') {
				updatePendingTransactionsAndSignableMessages(parsed)
				setPendingTransactionAddedNotification(true)
				try {
					const currentWindowId = (await browser.windows.getCurrent()).id
					if (currentWindowId === undefined) throw new Error('could not get current window Id!')
					const currentTabId = (await browser.tabs.getCurrent()).id
					if (currentTabId === undefined) throw new Error('could not get current tab Id!')
					await updateWindowIfExists(currentWindowId, { focused: true })
					await updateTabIfExists(currentTabId, { active: true })
				} catch(e) {
					console.warn('failed to focus window')
					console.warn(e)
				}
				return
			}
			if (parsed.method !== 'popup_update_confirm_transaction_dialog') return
			return updatePendingTransactionsAndSignableMessages(parsed)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_confirmTransactionReadyAndListening' }) }, [])

	async function approve() {
		if (currentPendingTransactionOrSignableMessage === undefined) throw new Error('dialogState is not set')
		setPendingTransactionAddedNotification(false)
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.uniqueRequestIdentifier, action: 'accept' } })
		} catch(error) {
			console.warn('Failed to confirm transaction')
			// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
			console.log({ error })
		}
	}
	async function reject() {
		if (currentPendingTransactionOrSignableMessage === undefined) throw new Error('dialogState is not set')
		setPendingTransactionAddedNotification(false)
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactionsAndSignableMessages.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransactionOrSignableMessage.uniqueRequestIdentifier.requestSocket.tabId })
		
		const getPossibleErrorString = () => {
			if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus === 'FailedToSimulate') return currentPendingTransactionOrSignableMessage.transactionToSimulate.error.message
			if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return undefined
			if (currentPendingTransactionOrSignableMessage.type !== 'Transaction') return undefined
			if (currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success' ) return undefined
			const results = currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions.find((tx) => tx.transactionIdentifier === currentPendingTransactionOrSignableMessage.transactionIdentifier)
			if (results === undefined) return undefined
			return results.statusCode === 'failure' ? results.error.message : undefined
		}
		
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.uniqueRequestIdentifier,
			action: 'reject',
			errorString: getPossibleErrorString(),
		} })
	}
	const refreshMetadata = async () => {
		if (currentPendingTransactionOrSignableMessage === undefined || currentPendingTransactionOrSignableMessage.type !== 'Transaction' || currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return
		if (currentPendingTransactionOrSignableMessage.simulationResults === undefined || currentPendingTransactionOrSignableMessage.simulationResults.statusCode === 'failed') return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata', data: currentPendingTransactionOrSignableMessage.simulationResults.data })
	}
	const refreshSimulation = async () => {
		if (currentPendingTransactionOrSignableMessage === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation' })
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		if (currentPendingTransactionOrSignableMessage === undefined) return true
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return true
		if (currentPendingTransactionOrSignableMessage.type !== 'Transaction') {
			return !isPossibleToSignMessage(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest, currentPendingTransactionOrSignableMessage.activeAddress) && !forceSend
			&& currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest.rpcNetwork.httpsRpc === undefined
		}
		if (currentPendingTransactionOrSignableMessage.simulationResults === undefined) return false
		if (currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success' ) return false
		if (currentPendingTransactionOrSignableMessage.approvalStatus.status === 'WaitingForSigner') return true
		const lastTx = getResultsForTransaction(currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransactionOrSignableMessage.transactionIdentifier)
		if (lastTx === undefined ) return false
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine === false
		return !success || !noQuarantines
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({
			windowStateId: addressString(entry.address),
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				askForAddressAccess: false,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				...entry,
				address: checksummedAddress(entry.address),
				abi: 'abi' in entry ? entry.abi : undefined
			}
		})
	}

	function Buttons() {
		const onlyReject = <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
				{ 'Reject' }
			</button>
		</div>

		if (currentPendingTransactionOrSignableMessage === undefined) return onlyReject
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return onlyReject

		const signerName = currentPendingTransactionOrSignableMessage.type === 'Transaction' ? currentPendingTransactionOrSignableMessage.simulationResults.data.signerName : currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest.signerName
		const identify = () => {
			if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest)
			const lastTx = currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success' ? undefined : getResultsForTransaction(currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransactionOrSignableMessage.transactionIdentifier)
			if (lastTx === undefined) return undefined
			return identifyTransaction(lastTx)
		}
		const identified = identify()
		if (identified === undefined) return onlyReject

		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right' onClick = { approve } disabled = { isConfirmDisabled() }>
				{ currentPendingTransactionOrSignableMessage.approvalStatus.status === 'WaitingForSigner' ? <>
					<span> <Spinner height = '1em' color = 'var(--text-color)' /> Waiting for <SignersLogoName signerName = { signerName } /> </span>
					</> : <>
						{ currentPendingTransactionOrSignableMessage.simulationMode
							? `${ identified.simulationAction }!`
							: <SignerLogoText signerName = { signerName } text = { identified.signingAction } />
						}
					</>
				}
			</button>
		</div>
	}

	const getLoadingText = (current: PendingTransactionOrSignableMessage | undefined) => {
		if (current === undefined) return 'Initializing...'
		if (current.transactionOrMessageCreationStatus === 'Crafting') return 'Crafting Transaction...'
		if (current.transactionOrMessageCreationStatus === 'Simulating') return 'Simulating Transaction...'
		if ('simulationResults' in current && current.simulationResults?.statusCode === 'failed') return 'Failed to simulate. Retrying...'
		return 'Loading...'
	}

	if (currentPendingTransactionOrSignableMessage === undefined || (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated' && currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'FailedToSimulate')) {
		return <> 
			<main>
				<Hint>
					<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
						{ addingNewAddress === 'renameAddressModalClosed'
							? <></>
							: <AddNewAddress
								setActiveAddressAndInformAboutIt = { undefined }
								modifyAddressWindowState = { addingNewAddress }
								close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
								activeAddress = { undefined }
							/>
						}
					</div>
					<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
						<UnexpectedError close = { () => { setUnexpectedError(undefined) } } message = { unexpectedError }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						{ currentPendingTransactionOrSignableMessage === undefined ? <></> : <>
							<WebsiteErrors website = { currentPendingTransactionOrSignableMessage.website } websiteSocket = { currentPendingTransactionOrSignableMessage.uniqueRequestIdentifier.requestSocket } simulationMode = { currentPendingTransactionOrSignableMessage.simulationMode }/>
						</> }
						<CenterToPageTextSpinner text = { getLoadingText(currentPendingTransactionOrSignableMessage)  }/>
					</div>
				</Hint>
			</main>
		</>
	}
	const underTransactions = pendingTransactionsAndSignableMessages.slice(1).reverse()
	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed'
						? <></>
						: <AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							modifyAddressWindowState = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>
				<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
					<div style = 'position: sticky; top: 0; z-index:1'>
						<UnexpectedError close = { () => { setUnexpectedError(undefined) } } message = { unexpectedError }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						<WebsiteErrors website = { currentPendingTransactionOrSignableMessage.website } websiteSocket = { currentPendingTransactionOrSignableMessage.uniqueRequestIdentifier.requestSocket } simulationMode = { currentPendingTransactionOrSignableMessage.simulationMode }/>
					</div>
					<div class = 'popup-contents'>
						<div style = 'padding: 10px'>
							{ currentPendingTransactionOrSignableMessage.originalRequestParameters.method === 'eth_sendRawTransaction' && currentPendingTransactionOrSignableMessage.type === 'Transaction'
								? <DinoSaysNotification
									text = { `This transaction is signed already. No extra signing required to forward it to ${ currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated' || currentPendingTransactionOrSignableMessage.simulationResults.statusCode === 'failed' ?
									'network' :
									currentPendingTransactionOrSignableMessage.simulationResults.data.simulationState.rpcNetwork.name }.` }
									close = { () => setPendingTransactionAddedNotification(false)}
								/>
								: <></>
							}
							{ pendingTransactionAddedNotification === true
								? <DinoSaysNotification
									text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ pendingTransactionsAndSignableMessages.length > 1 ? 's' : '' } to see the new one.` }
									close = { () => setPendingTransactionAddedNotification(false)}
								/>
								: <></>
							}
							<TransactionNames completeVisualizedSimulation = { completeVisualizedSimulation } currentPendingTransaction = { currentPendingTransactionOrSignableMessage }/>
							<UnderTransactions pendingTransactionsAndSignableMessages = { underTransactions }/>
							<div style = { `top: ${ underTransactions.length * -HALF_HEADER_HEIGHT }px` }></div>
							{ currentPendingTransactionOrSignableMessage.type === 'Transaction' ?
								<TransactionCard
									currentPendingTransaction = { currentPendingTransactionOrSignableMessage }
									pendingTransactionsAndSignableMessages = { pendingTransactionsAndSignableMessages }
									renameAddressCallBack = { renameAddressCallBack }
									currentBlockNumber = { currentBlockNumber }
									rpcConnectionStatus = { rpcConnectionStatus }
									numberOfUnderTransactions = { underTransactions.length }
								/>
							: <>
								<SignatureCard
									visualizedPersonalSignRequest = { currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest }
									renameAddressCallBack = { renameAddressCallBack }
									removeTransactionOrSignedMessage = { undefined }
									numberOfUnderTransactions = { underTransactions.length }
								/>
							</> }
						</div>
						<nav class = 'window-footer popup-button-row' style = 'position: sticky; bottom: 0; width: 100%;'>
							<CheckBoxes currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage } forceSend = { forceSend } setForceSend = { (enabled: boolean) => setForceSend(enabled) }/>
							<Buttons/>
						</nav>
					</div>
				</div>
			</Hint>
		</main>
	)
}
