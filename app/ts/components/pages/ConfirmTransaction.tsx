import { useState, useEffect } from 'preact/hooks'
import { ConfirmTransactionDialogPendingChanged, MessageToPopup, UpdateConfirmTransactionDialog } from '../../types/interceptor-messages.js'
import { ModifyAddressWindowState, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard, NonTokenLogAnalysisCard } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner, Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import { RpcConnectionStatus } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { ErrorCheckBox, UnexpectedError } from '../subcomponents/Error.js'
import { QuarantineReasons, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import { addressString, checksummedAddress, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { PendingTransaction } from '../../types/accessRequest.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { serialize } from '../../types/wire-types.js'
import { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { getWebsiteWarningMessage } from '../../utils/websiteData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { WebsiteSocket } from '../../utils/requests.js'
import { Link } from '../subcomponents/link.js'
import { NetworkErrors } from '../App.js'

type UnderTransactionsParams = {
	pendingTransactions: PendingTransaction[]
}

const getResultsForTransaction = (results: readonly SimulatedAndVisualizedTransaction[], transactionIdentifier: bigint) => {
	return results.find((result) => result.transactionIdentifier === transactionIdentifier)
}

const HALF_HEADER_HEIGHT = 48 / 2

function UnderTransactions(param: UnderTransactionsParams) {
	const nTx = param.pendingTransactions.length
	return <div style = {`position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;`}>
		{ param.pendingTransactions.map((pendingTransaction, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			if (pendingTransaction.status !== 'Simulated') return <div class = 'card' style = { style }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							{ pendingTransaction.status == 'FailedToSimulate' ? '../img/error-icon.svg' : <Spinner height = '2em'/> }
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ pendingTransaction.status == 'FailedToSimulate' ? pendingTransaction.transactionToSimulate.error.message : 'Simulating...' }
					</p>
					<p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden;` }>
						<WebsiteOriginText { ...pendingTransaction.website } />
					</p>
				</header>
				<div style = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'></div>
			</div>
			if (pendingTransaction.simulationResults.statusCode === 'success') {
				const simTx = getResultsForTransaction(pendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions, pendingTransaction.transactionIdentifier)
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

type TransactionNamesParams = { names: string[] }
const TransactionNames = (param: TransactionNamesParams) => {
	return <div class = 'block' style = 'margin-bottom: 10px;'>
		<nav class = 'breadcrumb has-succeeds-separator is-small'>
			<ul>
				{ param.names.map((name, index) => (
					<li style = 'margin: 0px;'>
						<div class = 'card' style = { `padding: 5px; margin: 5px; ${ index !== param.names.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
							<p class = 'paragraph' style = {`margin: 0px; ${ index !== param.names.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
								{ name }
							</p>
						</div>
					</li>
				)) }
			</ul>
		</nav>
	</div>
}

export type TransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	pendingTransactions: readonly PendingTransaction[],
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	currentBlockNumber: bigint | undefined,
	rpcConnectionStatus: RpcConnectionStatus,
}

export function TransactionCard(param: TransactionCardParams) {
	const pendingTransaction = param.pendingTransactions.at(0)
	if (pendingTransaction === undefined) return <p class = 'paragraph'> Unable to locate transaction...</p>
	const simTx = getResultsForTransaction(param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions, pendingTransaction.transactionIdentifier)
	const previousResults = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.filter((result) => result.transactionIdentifier !== pendingTransaction.transactionIdentifier)
	const transactionNames = previousResults.map((result) => identifyTransaction(result).title).concat(simTx === undefined ? 'Error' : identifyTransaction(simTx).title)
	const underTransactions = param.pendingTransactions.slice(1).reverse()
	if (simTx === undefined) {
		if (pendingTransaction.status === 'Crafting Transaction') return <></>
		return <>
			<TransactionNames names = { transactionNames }/>
			<UnderTransactions pendingTransactions = { underTransactions }/>
			<div class = 'card' style = { `top: ${ underTransactions.length * -HALF_HEADER_HEIGHT }px` }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							<img src = { '../img/error-icon.svg' } />
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ 'Gas estimation error' }
					</p>
					<p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden;` }>
						<WebsiteOriginText { ...pendingTransaction.transactionToSimulate.website } />
					</p>
				</header>
			
				<div class = 'card-content' style = 'padding-bottom: 5px;'>
					<div class = 'container'>
						{ pendingTransaction.status === 'FailedToSimulate' ? <>
							<DinoSaysNotification
								text = { `Hey! We were unable to calculate gas limit for this transaction. ${ pendingTransaction.transactionToSimulate.error.message }. data: ${ pendingTransaction.transactionToSimulate.error.data }` }
							/>
						</>
						: <DinoSaysNotification text = { `Unkown error occured with this transaction` } /> }
					</div>
					
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ stringifyJSONWithBigInts(serialize(OriginalSendRequestParameters, pendingTransaction.originalRequestParameters), 4) }</p>
					</div>

					<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: 33.33% 33.33% 33.33%;'>
						<div class = 'log-cell'>
						</div>
						<div class = 'log-cell' style = 'justify-content: center;'>
							<TransactionCreated created = { pendingTransaction.created } />
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
	return <>
		<TransactionNames names = { transactionNames }/>
		<UnderTransactions pendingTransactions = { underTransactions }/>
		<div class = 'card' style = { `top: ${ underTransactions.length * -HALF_HEADER_HEIGHT }px` }>
			<TransactionHeader simTx = { simTx } />
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock
						simTx = { simTx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
						addressMetadata = { param.simulationAndVisualisationResults.addressBookEntries }
					/>
				</div>
				<QuarantineReasons quarantineReasons = { simTx.quarantineReasons }/>

				<TransactionsAccountChangesCard
					simTx = { simTx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { param.simulationAndVisualisationResults.addressBookEntries }
					namedTokenIds = { param.simulationAndVisualisationResults.namedTokenIds }
				/>

				<TokenLogAnalysisCard simTx = { simTx } renameAddressCallBack = { param.renameAddressCallBack } />

				<NonTokenLogAnalysisCard
					simTx = { simTx }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { param.simulationAndVisualisationResults.addressBookEntries }
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
						<TransactionCreated created = { pendingTransaction.created } />
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

export type CheckBoxesParams = {
	currentResults: SimulatedAndVisualizedTransaction | undefined
	forceSend: boolean,
	setForceSend: (enabled: boolean) => void,
}
const CheckBoxes = (params: CheckBoxesParams) => {
	if (params.currentResults === undefined) return <></>
	if (params.currentResults.statusCode !== 'success') return <div style = 'display: grid'>
		<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
			<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { params.forceSend } onInput = { params.setForceSend } />
		</div>
	</div>
	if (params.currentResults.quarantine === true ) return <div style = 'display: grid'>
		<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
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

export const WebsiteErrors = ({ website, websiteSocket, simulationMode }: NetworkErrorParams) => {
	const message = getWebsiteWarningMessage(website.websiteOrigin, simulationMode)
	if (message === undefined) return <></>
	if (message.suggestedAlternative === undefined) return <ErrorComponent warning = { true } text = { message.message }/>
	return <ErrorComponent warning = { true } text = { <> { message.message } <Link url = { message.suggestedAlternative } text = { 'Suggested alternative' } websiteSocket = { websiteSocket } /> </> }/>
}

type LoadingParams = {
	loadingText: string
	unexpectedErrorMessage: string | undefined
	closeUnexpectedError: () => void
	rpcConnectionStatus: RpcConnectionStatus
}

function Loading({ loadingText, unexpectedErrorMessage, closeUnexpectedError, rpcConnectionStatus }: LoadingParams) {
	return <>
		<UnexpectedError close = { closeUnexpectedError } message = { unexpectedErrorMessage }/>
		<CenterToPageTextSpinner text = { loadingText }/>
		<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
	</>
}

export function ConfirmTransaction() {
	const [currentPendingTransaction, setCurrentPendingTransaction] = useState<PendingTransaction | undefined>(undefined)
	const [pendingTransactions, setPendingTransactions] = useState<readonly PendingTransaction[]>([])
	const [forceSend, setForceSend] = useState<boolean>(false)
	const [currentBlockNumber, setCurrentBlockNumber] = useState<undefined | bigint>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<ModifyAddressWindowState | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [rpcConnectionStatus, setRpcConnectionStatus] = useState<RpcConnectionStatus>(undefined)
	const [pendingTransactionAddedNotification, setPendingTransactionAddedNotification] = useState<boolean>(false)
	const [unexpectedError, setUnexpectedError] = useState<string | undefined>(undefined)

	const updatePendingTransactions = (message: ConfirmTransactionDialogPendingChanged | UpdateConfirmTransactionDialog) => {
		setPendingTransactions(message.data)
		const firstMessage = message.data[0]
		if (firstMessage === undefined) throw new Error('message data was undefined')
		setCurrentPendingTransaction(firstMessage)
		if (firstMessage.status === 'Simulated' && firstMessage.simulationResults !== undefined && firstMessage.simulationResults.statusCode === 'success' && (currentBlockNumber === undefined || firstMessage.simulationResults.data.simulationState.blockNumber > currentBlockNumber)) {
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
				updatePendingTransactions(parsed)
				setPendingTransactionAddedNotification(true)
				try {
					const currentWindowId = (await browser.windows.getCurrent()).id
					if (currentWindowId === undefined) throw new Error('could not get current window Id!')
					const currentTabId = (await browser.tabs.getCurrent()).id
					if (currentTabId === undefined) throw new Error('could not get current tab Id!')
					await browser.windows.update(currentWindowId, { focused: true })
					await browser.tabs.update(currentTabId, { active: true })
				} catch(e) {
					console.warn('failed to focus window')
					console.warn(e)
				}
				return
			}
			if (parsed.method !== 'popup_update_confirm_transaction_dialog') return
			return updatePendingTransactions(parsed)
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
		if (pendingTransactions.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransaction.uniqueRequestIdentifier.requestSocket.tabId })
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransaction.uniqueRequestIdentifier, accept: true, popupOrTabId: currentPendingTransaction.popupOrTabId } })
		} catch(e) {
			console.log('eerrr')
			console.log(e)
		}
	}
	async function reject() {
		if (currentPendingTransaction === undefined) throw new Error('dialogState is not set')
		setPendingTransactionAddedNotification(false)
		const currentWindow = await browser.windows.getCurrent()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactions.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransaction.uniqueRequestIdentifier.requestSocket.tabId })
		
		const getPossibleErrorString = () => {
			if (currentPendingTransaction.status === 'FailedToSimulate') return currentPendingTransaction.transactionToSimulate.error.message
			if (currentPendingTransaction.status !== 'Simulated') return undefined
			if (currentPendingTransaction.simulationResults.statusCode !== 'success' ) return undefined
			const results = currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions.find((tx) => tx.transactionIdentifier === currentPendingTransaction.transactionIdentifier)
			if (results === undefined) return undefined
			return results.statusCode === 'failure' ? results.error : undefined
		}
		
		await sendPopupMessageToBackgroundPage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransaction.uniqueRequestIdentifier,
			accept: false,
			popupOrTabId: currentPendingTransaction.popupOrTabId,
			transactionErrorString: getPossibleErrorString(),
		} })
	}
	const refreshMetadata = async () => {
		if (currentPendingTransaction === undefined || currentPendingTransaction.status !== 'Simulated') return
		if (currentPendingTransaction.simulationResults === undefined || currentPendingTransaction.simulationResults.statusCode === 'failed') return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata', data: currentPendingTransaction.simulationResults.data })
	}
	const refreshSimulation = async () => {
		if (currentPendingTransaction === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation', data: { } })
	}

	function isConfirmDisabled() {
		if (forceSend) return false
		if (currentPendingTransaction === undefined) return true
		if (currentPendingTransaction.status !== 'Simulated') return true
		if (currentPendingTransaction.simulationResults === undefined) return false
		if (currentPendingTransaction.simulationResults.statusCode !== 'success' ) return false
		const lastTx = getResultsForTransaction(currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransaction.transactionIdentifier)
		if (lastTx === undefined ) return false
		const success = lastTx.statusCode === 'success'
		const noQuarantines = lastTx.quarantine == false
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
		const lastTx = currentPendingTransaction === undefined || currentPendingTransaction.status !== 'Simulated' || currentPendingTransaction.simulationResults.statusCode !== 'success'
			? undefined : getResultsForTransaction(currentPendingTransaction.simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransaction.transactionIdentifier)
		if (lastTx === undefined || currentPendingTransaction === undefined || currentPendingTransaction.status !== 'Simulated') {
			return <div style = 'display: flex; flex-direction: row;'>
				<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
					{ 'Reject' }
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

	const getLoadingText = (current: PendingTransaction | undefined) => {
		if (current === undefined) return 'Initializing...'
		if (current.status === 'Crafting Transaction') return 'Crafting Transaction...'
		if (current.status === 'Simulating') return 'Simulating Transaction...'
		if (current.simulationResults?.statusCode === 'failed') return 'Failed to simulate. Retrying...'
		return 'Loading...'
	}

	if (currentPendingTransaction === undefined || currentPendingTransaction.status === 'Crafting Transaction' || currentPendingTransaction.status === 'Simulating' || currentPendingTransaction.simulationResults?.statusCode === 'failed') {
		return <Loading loadingText = { getLoadingText(currentPendingTransaction) } unexpectedErrorMessage = { unexpectedError } closeUnexpectedError = { () => { setUnexpectedError(undefined) } } rpcConnectionStatus = { rpcConnectionStatus } />
	}
	const simulationResults = currentPendingTransaction.simulationResults
	const currentResults = simulationResults === undefined ? undefined : getResultsForTransaction(simulationResults.data.simulatedAndVisualizedTransactions, currentPendingTransaction.transactionIdentifier)
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
						<WebsiteErrors website = { currentPendingTransaction.website } websiteSocket = { currentPendingTransaction.uniqueRequestIdentifier.requestSocket } simulationMode = { currentPendingTransaction.simulationMode }/>
					</div>
					<div class = 'popup-contents'>
						<div style = 'padding: 10px'>
							{ currentPendingTransaction.originalRequestParameters.method === 'eth_sendRawTransaction'
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
							<TransactionCard
								simulationAndVisualisationResults = { {
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
								} }
								pendingTransactions = { pendingTransactions }
								renameAddressCallBack = { renameAddressCallBack }
								activeAddress = { currentPendingTransaction.activeAddress }
								currentBlockNumber = { currentBlockNumber }
								rpcConnectionStatus = { rpcConnectionStatus }
							/>
						</div>
						<nav class = 'window-footer popup-button-row' style = 'position: sticky; bottom: 0; width: 100%;'>
							<CheckBoxes currentResults = { currentResults } forceSend = { forceSend } setForceSend = { (enabled: boolean) => setForceSend(enabled) }/>
							<Buttons/>
						</nav>
					</div>
				</div>
			</Hint>
		</main>
	)
}
