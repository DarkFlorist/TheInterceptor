import { useEffect } from 'preact/hooks'
import { MessageToPopup, UnexpectedErrorOccured, UpdateConfirmTransactionDialog } from '../../types/interceptor-messages.js'
import { CompleteVisualizedSimulation, EditEnsNamedHashWindowState, ModifyAddressWindowState, SimulatedAndVisualizedTransaction } from '../../types/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard, NonTokenLogAnalysisCard } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner, Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../types/user-interface-types.js'
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
import { EthereumBytes32, serialize } from '../../types/wire-types.js'
import { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { getWebsiteWarningMessage } from '../../utils/websiteData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { WebsiteSocket, checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { Link } from '../subcomponents/link.js'
import { NetworkErrors } from '../App.js'
import { InvalidMessage, SignatureCard, SignatureHeader, identifySignature, isPossibleToSignMessage } from './PersonalSign.js'
import { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import { RpcEntries } from '../../types/rpc.js'

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
							{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? <img src = '../img/error-icon.svg'/> : <Spinner height = '2em'/> }
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
	const makingRich = param.completeVisualizedSimulation.simulationState?.addressToMakeRich !== undefined
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

	const namesWithCurrentTransaction = [...makingRich ? ['Simply making you rich'] : [], ...names, titleOfCurrentPendingTransaction() ]
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
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	currentBlockNumber: bigint | undefined,
	rpcConnectionStatus: Signal<RpcConnectionStatus>,
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
						<ErrorComponent text = { `The transaction fails with an error '${ getErrorMesssage() }'` } containerStyle = { { margin: '0px' } } />
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
		tokenPriceEstimates: simulationResults.data.tokenPriceEstimates,
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
						editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
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
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					addressMetaData = { simulationAndVisualisationResults.addressBookEntries }
				/>

				<RawTransactionDetailsCard transaction = { simTx.transaction } transactionIdentifier = { simTx.transactionIdentifier } parsedInputData = { simTx.parsedInputData } renameAddressCallBack = { param.renameAddressCallBack } gasSpent = { simTx.gasSpent } addressMetaData = { simulationAndVisualisationResults.addressBookEntries } />

				<SenderReceiver
					from = { simTx.transaction.from }
					to = { simTx.transaction.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: 33.33% 33.33% 33.33%;'>
					<div class = 'log-cell'>
						<span class = 'log-table' style = { { display: 'inline-flex'} }>
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
	forceSend: Signal<boolean>,
}
const CheckBoxes = (params: CheckBoxesParams) => {
	if (params.currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	const setForceSend = (checked: boolean) => { params.forceSend.value = checked }
	if (params.currentPendingTransactionOrSignableMessage.type === 'SignableMessage') {
		const visualizedPersonalSignRequest = params.currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest
		return  <>
			{ isPossibleToSignMessage(visualizedPersonalSignRequest, visualizedPersonalSignRequest.activeAddress.address) && visualizedPersonalSignRequest.quarantine
				? <div style = 'display: grid'>
					<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
						<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend.value } onInput = { setForceSend } />
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
			<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { params.forceSend.value } onInput = { setForceSend } />
		</div>
	</div>
	if (currentResults.quarantine === true ) return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend.value } onInput = { setForceSend } />
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

type ModalState =
	{ page: 'modifyAddress', state: ModifyAddressWindowState } |
	{ page: 'editEns', state: EditEnsNamedHashWindowState } |
	{ page: 'noModal' }

type RejectButtonParams = {
	onClick: () => void
}
const RejectButton = ({ onClick }: RejectButtonParams) => {
	return <div style = 'display: flex;'>
		<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { onClick } >
			{ 'Reject' }
		</button>
	</div>
}

type ButtonsParams = {
	currentPendingTransactionOrSignableMessage: PendingTransactionOrSignableMessage | undefined
	reject: () => void
	approve: () => void
	confirmDisabled: ReadonlySignal<boolean>
}
function Buttons({ currentPendingTransactionOrSignableMessage, reject, approve, confirmDisabled }: ButtonsParams) {
	if (currentPendingTransactionOrSignableMessage === undefined) return <RejectButton onClick = { reject }/>
	if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return <RejectButton onClick = { reject }/>

	const signerName = currentPendingTransactionOrSignableMessage.type === 'Transaction' ? currentPendingTransactionOrSignableMessage.simulationResults.data.signerName : currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest.signerName
	const identify = () => {
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest)
		const lastTx = currentPendingTransactionOrSignableMessage.simulationResults.statusCode !== 'success' ? undefined : getResultsForTransaction(currentPendingTransactionOrSignableMessage.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransactionOrSignableMessage.transactionIdentifier)
		if (lastTx === undefined) return undefined
		return identifyTransaction(lastTx)
	}
	const identified = identify()
	if (identified === undefined) return <RejectButton onClick = { reject }/>

	return <div style = 'display: flex; flex-direction: row;'>
		<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
			{ identified.rejectAction }
		</button>
		<button className = 'button is-primary button-overflow dialog-button-right' onClick = { approve } disabled = { confirmDisabled }>
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

export function ConfirmTransaction() {
	const currentPendingTransactionOrSignableMessage = useSignal<PendingTransactionOrSignableMessage | undefined>(undefined)
	const pendingTransactionsAndSignableMessages = useSignal<readonly PendingTransactionOrSignableMessage[]>([])
	const completeVisualizedSimulation = useSignal<CompleteVisualizedSimulation | undefined>(undefined)
	const forceSend = useSignal<boolean>(false)
	const currentBlockNumber = useSignal<undefined | bigint>(undefined)
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const pendingTransactionAddedNotification = useSignal<boolean>(false)
	const unexpectedError = useSignal<undefined | UnexpectedErrorOccured>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])

	const updatePendingTransactionsAndSignableMessages = (message: UpdateConfirmTransactionDialog) => {
		completeVisualizedSimulation.value = message.data.visualizedSimulatorState
		currentBlockNumber.value = message.data.currentBlockNumber
	}
	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value

			if (parsed.method === 'popup_settingsUpdated') return sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
			if (parsed.method === 'popup_requestSettingsReply') {
				rpcEntries.value = parsed.data.rpcEntries
				return
			}
			if (parsed.method === 'popup_UnexpectedErrorOccured') return unexpectedError.value = parsed
			if (parsed.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (parsed.method === 'popup_new_block_arrived') {
				rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
				refreshSimulation()
				currentBlockNumber.value = parsed.data.rpcConnectionStatus?.latestBlock?.number
				return
			}
			if (parsed.method === 'popup_failed_to_get_block') {
				rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
				return
			}
			if (parsed.method === 'popup_update_confirm_transaction_dialog') {
				return updatePendingTransactionsAndSignableMessages(UpdateConfirmTransactionDialog.parse(parsed))
			}
			if (parsed.method === 'popup_update_confirm_transaction_dialog_pending_transactions') {
				pendingTransactionsAndSignableMessages.value = parsed.data.pendingTransactionAndSignableMessages
				const firstMessage = parsed.data.pendingTransactionAndSignableMessages[0]
				if (firstMessage === undefined) throw new Error('message data was undefined')
				currentPendingTransactionOrSignableMessage.value = firstMessage
				if (firstMessage.type === 'Transaction' && (firstMessage.transactionOrMessageCreationStatus === 'Simulated' || firstMessage.transactionOrMessageCreationStatus === 'FailedToSimulate') && firstMessage.simulationResults !== undefined && firstMessage.simulationResults.statusCode === 'success' && (currentBlockNumber.value === undefined || firstMessage.simulationResults.data.simulationState.blockNumber > currentBlockNumber.value)) {
					currentBlockNumber.value = firstMessage.simulationResults.data.simulationState.blockNumber
				}
			}
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => {
		sendPopupMessageToBackgroundPage({ method: 'popup_confirmTransactionReadyAndListening' })
		sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
	}, [])

	async function approve() {
		if (currentPendingTransactionOrSignableMessage.value === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier, action: 'accept' } })
		} catch(error) {
			console.warn('Failed to confirm transaction')
			// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
			console.log({ error })
		}
	}
	async function reject() {
		if (currentPendingTransactionOrSignableMessage.value === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactionsAndSignableMessages.value.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier.requestSocket.tabId })

		const getPossibleErrorString = () => {
			const pending = currentPendingTransactionOrSignableMessage.value
			if (pending === undefined) return undefined
			if (pending.transactionOrMessageCreationStatus === 'FailedToSimulate') return pending.transactionToSimulate.error.message
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return undefined
			if (pending.type !== 'Transaction') return undefined
			if (pending.simulationResults.statusCode !== 'success' ) return undefined
			const results = pending.simulationResults.data.simulatedAndVisualizedTransactions.find((tx) => tx.transactionIdentifier === pending.transactionIdentifier)
			if (results === undefined) return undefined
			return results.statusCode === 'failure' ? results.error.message : undefined
		}

		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier,
			action: 'reject',
			errorString: getPossibleErrorString(),
		} })
	}
	const refreshMetadata = async () => {
		if (currentPendingTransactionOrSignableMessage === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata'})
	}
	const refreshSimulation = async () => {
		if (currentPendingTransactionOrSignableMessage === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation' })
	}

	const isConfirmDisabled = useComputed(() => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return true
		if (currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated') return true
		if (currentPendingTransactionOrSignableMessage.value.type !== 'Transaction') {
			if (currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest.isValidMessage !== true) return true
			return !isPossibleToSignMessage(currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest, currentPendingTransactionOrSignableMessage.value.activeAddress) && !forceSend
			&& currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest.rpcNetwork.httpsRpc === undefined
		}
		if (forceSend.value) return false
		if (currentPendingTransactionOrSignableMessage.value.simulationResults === undefined) return false
		if (currentPendingTransactionOrSignableMessage.value.simulationResults.statusCode !== 'success' ) return false
		if (currentPendingTransactionOrSignableMessage.value.approvalStatus.status === 'WaitingForSigner') return true
		const lastTx = getResultsForTransaction(currentPendingTransactionOrSignableMessage.value.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransactionOrSignableMessage.value.transactionIdentifier)
		if (lastTx === undefined ) return false
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine === false
		return !success || !noQuarantines
	})

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = {
			page: 'modifyAddress',
			state: {
				windowStateId: addressString(entry.address),
				errorState: undefined,
				incompleteAddressBookEntry: {
					addingAddress: false,
					askForAddressAccess: true,
					symbol: undefined,
					decimals: undefined,
					logoUri: undefined,
					useAsActiveAddress: false,
					abi : undefined,
					declarativeNetRequestBlockMode: undefined,
					chainId: entry.chainId || 1n,
					...entry,
					address: checksummedAddress(entry.address),
				}
			}
		}
	}

	function editEnsNamedHashCallBack(type: 'nameHash' | 'labelHash', nameHash: EthereumBytes32, name: string | undefined) {
		modalState.value = {
			page: 'editEns',
			state: { type, nameHash, name }
		}
	}

	const getLoadingText = (current: PendingTransactionOrSignableMessage | undefined) => {
		if (current === undefined) return 'Initializing...'
		if (current.transactionOrMessageCreationStatus === 'Crafting') return 'Crafting Transaction...'
		if (current.transactionOrMessageCreationStatus === 'Simulating') return 'Simulating Transaction...'
		if ('simulationResults' in current && current.simulationResults?.statusCode === 'failed') return 'Failed to simulate. Retrying...'
		return 'Loading...'
	}

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		await sendPopupMessageToBackgroundPage( { method: 'popup_clearUnexpectedError' } )
	}

	const modifyAddressSignal: ReadonlySignal<ModifyAddressWindowState | undefined> = useComputed(() => modalState.value.page === 'modifyAddress' ? modalState.value.state : undefined)
	if (currentPendingTransactionOrSignableMessage.value === undefined || (currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated' && currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'FailedToSimulate')) {
		return <>
			<main>
				<Hint>
					<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
						{ modalState.value.page === 'editEns' ?
							<EditEnsLabelHash
								close = { () => { modalState.value = { page: 'noModal' } } }
								editEnsNamedHashWindowState = { modalState.value.state }
							/>
						: <></> }
						{ modifyAddressSignal.value !== undefined ?
							<AddNewAddress
								setActiveAddressAndInformAboutIt = { undefined }
								modifyAddressWindowState = { modifyAddressSignal }
								close = { () => { modalState.value = { page: 'noModal' } } }
								activeAddress = { currentPendingTransactionOrSignableMessage.value?.activeAddress }
								rpcEntries = { rpcEntries }
								modifyStateCallBack = { (newState: ModifyAddressWindowState) => {
									if (modalState.value.page !== 'modifyAddress') return
									modalState.value = { page: modalState.value.page, state: newState }
								} }
							/>
						: <></> }
					</div>
					<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px;'>
						<UnexpectedError close = { clearUnexpectedError } unexpectedError = { unexpectedError.value }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						{ currentPendingTransactionOrSignableMessage.value === undefined ? <></> : <>
							<WebsiteErrors website = { currentPendingTransactionOrSignableMessage.value.website } websiteSocket = { currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier.requestSocket } simulationMode = { currentPendingTransactionOrSignableMessage.value.simulationMode }/>
							<InvalidMessage pendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage.value }/>
						</> }
						<CenterToPageTextSpinner text = { getLoadingText(currentPendingTransactionOrSignableMessage.value)  }/>
					</div>
				</Hint>
			</main>
		</>
	}
	const underTransactions = useComputed(() => pendingTransactionsAndSignableMessages.value.slice(1).reverse())
	return (
		<main>
			<Hint>
				<div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
					{ modalState.value.page === 'editEns' ?
						<EditEnsLabelHash
							close = { () => { modalState.value = { page: 'noModal' } } }
							editEnsNamedHashWindowState = { modalState.value.state }
						/>
					: <></> }
					{ modifyAddressSignal !== undefined ?
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							modifyAddressWindowState = { modifyAddressSignal }
							close = { () => { modalState.value = { page: 'noModal' } } }
							activeAddress = { currentPendingTransactionOrSignableMessage.value?.activeAddress }
							rpcEntries = { rpcEntries }
							modifyStateCallBack = { (newState: ModifyAddressWindowState) => {
								if (modalState.value.page !== 'modifyAddress') return
								modalState.value = { page: modalState.value.page, state: newState }
							} }
						/>
					: <></> }
				</div>
				<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
					<div style = 'position: sticky; top: 0; z-index: 1;'>
						<UnexpectedError close = { clearUnexpectedError } unexpectedError = { unexpectedError.value }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						<WebsiteErrors website = { currentPendingTransactionOrSignableMessage.value.website } websiteSocket = { currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier.requestSocket } simulationMode = { currentPendingTransactionOrSignableMessage.value.simulationMode }/>
						<InvalidMessage pendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage.value }/>
					</div>
					<div class = 'popup-contents'>
						<div style = 'margin: 10px'>
							{ currentPendingTransactionOrSignableMessage.value.originalRequestParameters.method === 'eth_sendRawTransaction' && currentPendingTransactionOrSignableMessage.value.type === 'Transaction'
								? <DinoSaysNotification
									text = { `This transaction is signed already. No extra signing required to forward it to ${ currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated' || currentPendingTransactionOrSignableMessage.value.simulationResults.statusCode === 'failed' ?
									'network' :
									currentPendingTransactionOrSignableMessage.value.simulationResults.data.simulationState.rpcNetwork.name }.` }
									close = { () => { pendingTransactionAddedNotification.value = false } }
								/>
								: <></>
							}
							{ pendingTransactionAddedNotification.value === true
								? <DinoSaysNotification
									text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ pendingTransactionsAndSignableMessages.value.length > 1 ? 's' : '' } to see the new one.` }
									close = { () => { pendingTransactionAddedNotification.value = false }}
								/>
								: <></>
							}
							<TransactionNames completeVisualizedSimulation = { completeVisualizedSimulation.value } currentPendingTransaction = { currentPendingTransactionOrSignableMessage.value }/>
							<UnderTransactions pendingTransactionsAndSignableMessages = { underTransactions.value }/>
							<div style = { `top: ${ underTransactions.value.length * -HALF_HEADER_HEIGHT }px` }></div>
							{ currentPendingTransactionOrSignableMessage.value.type === 'Transaction' ?
								<TransactionCard
									currentPendingTransaction = { currentPendingTransactionOrSignableMessage.value }
									pendingTransactionsAndSignableMessages = { pendingTransactionsAndSignableMessages.value }
									renameAddressCallBack = { renameAddressCallBack }
									editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
									currentBlockNumber = { currentBlockNumber.value }
									rpcConnectionStatus = { rpcConnectionStatus }
									numberOfUnderTransactions = { underTransactions.value.length }
								/>
							: <>
								<SignatureCard
									visualizedPersonalSignRequest = { currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest }
									renameAddressCallBack = { renameAddressCallBack }
									removeTransactionOrSignedMessage = { undefined }
									numberOfUnderTransactions = { underTransactions.value.length }
									editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
								/>
							</> }
						</div>
						<nav class = 'window-footer popup-button-row' style = 'position: sticky; bottom: 0; width: 100%;'>
							<CheckBoxes currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage.value } forceSend = { forceSend } />
							<Buttons
								currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage.value }
								reject = { reject }
								approve = { approve }
								confirmDisabled = { isConfirmDisabled }
							/>
						</nav>
					</div>
				</div>
			</Hint>
		</main>
	)
}
