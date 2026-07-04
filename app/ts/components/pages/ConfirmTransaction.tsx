import { useEffect } from 'preact/hooks'
import { MessageToPopup, type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { type CompleteVisualizedSimulation, type EditEnsNamedHashWindowState, type MaybeSimulatedTransaction, type ModifyAddressWindowState, type VisualizedSimulationState, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import Hint from '../subcomponents/Hint.js'
import { GasLimitEditor, RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, SimulatedInBlockNumber, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, TransactionsAccountChangesCard, NonTokenLogAnalysisCard, getSimulationDisplayBlockNumber } from '../simulationExplaining/SimulationSummary.js'
import { CenterToPageTextSpinner, Spinner } from '../subcomponents/Spinner.js'
import { AddNewAddress } from './AddNewAddress.js'
import type { RenameAddressCallBack, RpcConnectionStatus } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { type CaughtError, ErrorCheckBox, UnexpectedError } from '../subcomponents/Error.js'
import { QuarantineReasons, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { addressEditEntry, tryFocusingTabOrWindow } from '../ui-utils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { PopupPendingTransactionOrSignableMessage as PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../../types/accessRequest.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { SmallAddress } from '../subcomponents/address.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import type { EthereumBytes32 } from '../../types/wire-types.js'
import type { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import { getWebsiteWarningMessage } from '../../utils/websiteData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { Link } from '../subcomponents/link.js'
import { NetworkErrors } from '../subcomponents/NetworkErrors.js'
import { identifySignature } from '../simulationExplaining/identifySignature.js'
import { InvalidMessage, SignatureCard, SignatureHeader, isPossibleToSignMessage } from './PersonalSign.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { type ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import type { RpcEntries } from '../../types/rpc.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance, markPerformanceOnce } from '../../utils/popupPerformance.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { dataStringWith0xStart } from '../../utils/bigint.js'
import { browserStorageLocalGet2 } from '../../utils/storageUtils.js'
import { reportUnexpectedError } from '../../utils/errors.js'

type UnderTransactionsParams = {
	pendingTransactionsAndSignableMessages: ReadonlySignal<PendingTransactionOrSignableMessage[]>
}

export const CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS = 150
export const CONFIRM_TRANSACTION_BOOTSTRAP_MAX_ATTEMPTS = 10
const CONFIRM_TRANSACTION_DATA_PRIORITY = {
	storage: 1,
	bootstrap: 2,
	push: 3,
} as const

const waitForDelay = async (delayMs: number) => await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))

type ConfirmTransactionBootstrapData = {
	pendingTransactionAndSignableMessages: readonly PendingTransactionOrSignableMessage[]
	currentBlockNumber: bigint
	rpcConnectionStatus: RpcConnectionStatus
	visualizedSimulatorState: CompleteVisualizedSimulation
}

export async function bootstrapConfirmTransactionDialog(
	hasLoadedPendingTransaction: () => boolean,
	applyBootstrapData: (bootstrapData: ConfirmTransactionBootstrapData) => void,
) {
	for (let attempt = 0; attempt < CONFIRM_TRANSACTION_BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
		if (hasLoadedPendingTransaction()) return
		const reply = await sendPopupMessageWithReply({ method: 'popup_readyAndListening', data: { page: 'confirmTransaction' } })
		if (reply?.method === 'popup_readyAndListening' && reply.data.confirmTransactionBootstrap !== undefined) {
			applyBootstrapData(reply.data.confirmTransactionBootstrap)
		}
		if (hasLoadedPendingTransaction()) return
		await waitForDelay(CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS)
	}
}

async function hydratePendingTransactionsFromStorage() {
	return (await browserStorageLocalGet2('pendingTransactionsAndMessages')).pendingTransactionsAndMessages ?? []
}

const getResultsForTransaction = (visualizedSimulationState: VisualizedSimulationState, transactionIdentifier: bigint) => {
	return visualizedSimulationState.visualizedBlocks
		.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
		.find((transaction) => transaction.transactionIdentifier === transactionIdentifier)
}

export function getAddressBookEntryForEdit(clickedEntry: AddressBookEntry, addressBookEntries: readonly AddressBookEntry[]) {
	const exactChainEntry = addressBookEntries.find((entry) => entry.address === clickedEntry.address && entry.chainId === clickedEntry.chainId)
	if (exactChainEntry !== undefined) return exactChainEntry
	const mainnetFallbackEntry = addressBookEntries.find((entry) => entry.address === clickedEntry.address && entry.chainId === undefined && clickedEntry.chainId === 1n)
	if (mainnetFallbackEntry !== undefined) return mainnetFallbackEntry
	return addressBookEntries.find((entry) => entry.address === clickedEntry.address) ?? clickedEntry
}

const HALF_HEADER_HEIGHT = 48 / 2

export function shouldDisableSignableMessageConfirm(params: {
	isValidMessage: boolean
	canSignMessage: boolean
	forceSendEnabled: boolean
	hasSupportedRpc: boolean
}) {
	if (!params.isValidMessage) return true
	return !params.canSignMessage && !params.forceSendEnabled && !params.hasSupportedRpc
}

export function getConfirmDialogDeliveryErrorMessage(error: unknown) {
	const reason = error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: 'Unknown error'
	return `Failed to confirm transaction: ${ reason }`
}

export async function sendConfirmDialogMessage(message: TransactionConfirmation): Promise<CaughtError | undefined> {
	try {
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport(message)
	} catch(error) {
		const errorMessage = await reportUnexpectedError(error, {
			source: 'confirmTransaction',
			code: 'confirm_dialog_delivery_failed',
			displayMessage: getConfirmDialogDeliveryErrorMessage(error),
			suppressExpectedInfrastructure: false,
		})
		return errorMessage?.data
	}
	return undefined
}

function UnderTransactions(param: UnderTransactionsParams) {
	const absoluteStyle = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'
	const nTx = param.pendingTransactionsAndSignableMessages.value.length
	return <div style = { `position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;` }>
		{ param.pendingTransactionsAndSignableMessages.value.map((pendingTransaction, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			const stackItemKey = pendingTransaction.type === 'Transaction'
				? `transaction-${ pendingTransaction.transactionIdentifier.toString() }`
				: `message-${ pendingTransaction.uniqueRequestIdentifier.requestId.toString() }`
			if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return <div key = { stackItemKey } class = 'card' style = { style }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? <img src = '../img/error-icon.svg' width = '24' height = '24'/> : <Spinner height = '2em'/> }
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? pendingTransaction.transactionToSimulate.error.message : 'Simulating...' }
					</p>
					<WebsiteOriginText website = { pendingTransaction.website } class = 'card-header-website' />
				</header>
				<div style = { absoluteStyle }></div>
			</div>
			if (pendingTransaction.type === 'Transaction') {
				if (pendingTransaction.popupVisualisation.statusCode === 'success' && pendingTransaction.popupVisualisation.data.visualizedSimulationState.success) {
					const simTx = getResultsForTransaction(pendingTransaction.popupVisualisation.data.visualizedSimulationState, pendingTransaction.transactionIdentifier)
					if (simTx === undefined) throw new Error('No simulated and visualized transactions')
					return <div key = { stackItemKey } class = 'card' style = { style }>
						<TransactionHeader simTx = { simTx } />
						<div style = { absoluteStyle }></div>
					</div>
				}
				return <div key = { stackItemKey } class = 'card' style = { style }>
					<TransactionHeaderForFailedToSimulate website = { pendingTransaction.transactionToSimulate.website } />
					<div style = { absoluteStyle }></div>
				</div>
			}
			return <div key = { stackItemKey } class = 'card' style = { style }>
				<SignatureHeader visualizedPersonalSignRequest = { pendingTransaction.visualizedPersonalSignRequest }/>
				<div style = { absoluteStyle }></div>
			</div>
		}) }
	</div>
}

type TransactionNamesParams = {
	includeCurrentTransaction: boolean
	completeVisualizedSimulation: Signal<CompleteVisualizedSimulation>
	currentPendingTransaction: Signal<PendingTransactionOrSignableMessage| undefined>
}

export const TransactionNames = (param: TransactionNamesParams) => {
	if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough') return <></>

	const titleOfCurrentPendingTransaction = () => {
		const currentPendingTransactionOrSignableMessage = param.currentPendingTransaction.value
		if (currentPendingTransactionOrSignableMessage === undefined) return 'Loading...'
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest).title
		if (currentPendingTransactionOrSignableMessage.popupVisualisation.statusCode === 'failed') return 'Failing transaction'
		const lastTx = currentPendingTransactionOrSignableMessage.popupVisualisation.statusCode !== 'success' || currentPendingTransactionOrSignableMessage.popupVisualisation.data.visualizedSimulationState.success === false ? undefined : getResultsForTransaction(currentPendingTransactionOrSignableMessage.popupVisualisation.data.visualizedSimulationState, currentPendingTransactionOrSignableMessage.transactionIdentifier)
		if (lastTx === undefined) return 'Could not find transaction...'
		return identifyTransaction(lastTx).title
	}

	const namesWithCurrentTransaction = useComputed(() => {
		if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough' || param.completeVisualizedSimulation.value.visualizedSimulationState.success === false) return []
		const visualizedBlocks = param.completeVisualizedSimulation.value.visualizedSimulationState.visualizedBlocks
		const transactionsAndMessages = visualizedBlocks.flatMap((block) => [...block.visualizedPersonalSignRequests, ...block.simulatedAndVisualizedTransactions])
		const names = transactionsAndMessages.map((transactionOrMessage) => 'transaction' in transactionOrMessage ? identifyTransaction(transactionOrMessage).title : identifySignature(transactionOrMessage).title)
		return [...param.completeVisualizedSimulation.value.numberOfAddressesMadeRich > 0 ? [`Simply making ${ param.completeVisualizedSimulation.value.numberOfAddressesMadeRich } addresses rich`] : [], ...names, ...param.includeCurrentTransaction ? [titleOfCurrentPendingTransaction()] : [] ]
	})

	return <nav class = 'breadcrumb has-succeeds-separator is-small'>
		<ul>
			{ namesWithCurrentTransaction.value.map((name, index) => (
				<li key = { `${ index }-${ name }` } style = 'margin: 0px;'>
					<div class = 'card' style = { `padding: 5px; margin: 5px; ${ index !== namesWithCurrentTransaction.value.length - 1 && param.includeCurrentTransaction ? 'background-color: var(--disabled-card-color)' : ''}` }>
						<p class = 'paragraph' style = { `margin: 0px; ${ index !== namesWithCurrentTransaction.value.length - 1 && param.includeCurrentTransaction ? 'color: var(--disabled-text-color)' : ''}` }>
							{ name }
						</p>
					</div>
				</li>
			)) }
		</ul>
	</nav>
}

type TransactionCardParams = {
	currentPendingTransaction: ReadonlySignal<PendingTransactionOrSignableMessage | undefined>,
	pendingTransactionsAndSignableMessages: readonly PendingTransactionOrSignableMessage[],
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	currentBlockNumber: Signal<bigint | undefined>,
	rpcConnectionStatus: Signal<RpcConnectionStatus>,
	numberOfUnderTransactions: number,
}

function FailedTransactionPreviewDetails({
	website,
	transactionIdentifier,
	originalRequestParameters,
	addressMetaData,
	created,
	errorMessage,
	isGasEstimationError,
	simulationBlockNumber,
	simulationConductedTimestamp,
	rpcConnectionStatus,
	currentBlockNumber,
}: {
	website: Website
	transactionIdentifier: bigint
	originalRequestParameters: OriginalSendRequestParameters
	addressMetaData: readonly AddressBookEntry[]
	created: Date
	errorMessage: string
	isGasEstimationError: boolean
	simulationBlockNumber: bigint
	simulationConductedTimestamp: Date
	rpcConnectionStatus: Signal<RpcConnectionStatus>
	currentBlockNumber: Signal<bigint | undefined>
}) {
	const request = originalRequestParameters.method === 'eth_sendTransaction' ? originalRequestParameters.params[0] : undefined
	const rawRequest = originalRequestParameters.method === 'eth_sendRawTransaction' ? originalRequestParameters.params[0] : undefined
	const from = request?.from === undefined ? undefined : getAddressBookEntryOrAFiller(addressMetaData, request.from)
	const to = request?.to === null || request?.to === undefined ? undefined : getAddressBookEntryOrAFiller(addressMetaData, request.to)
	const input = request === undefined ? new Uint8Array() : request.input ?? request.data ?? new Uint8Array()
	const gasLimit = request?.gas

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header'>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon'>
					<img src = '../img/error-icon.svg' width = '24' height = '24'/>
				</span>
			</div>
			<p class = 'card-header-title' style = 'white-space: nowrap;'>
				{ isGasEstimationError ? 'Gas estimation error' : 'Execution error' }
			</p>
			<WebsiteOriginText website = { website } class = 'card-header-website' />
		</header>
		<div class = 'card-content' style = 'padding-bottom: 5px;'>
			<div class = 'container'>
				<ErrorComponent text = { `The transaction fails with an error '${ errorMessage }'` } containerStyle = { { margin: '0px', marginBottom: '10px' } } />
				<dl class = 'grid key-value-pair'>
					<dt>Transaction type</dt>
					<dd>{ originalRequestParameters.method }</dd>
					<dt>From</dt>
					<dd>{ from === undefined ? 'Unknown' : <SmallAddress addressBookEntry = { from } renameAddressCallBack = { () => undefined } /> }</dd>
					<dt>To</dt>
					<dd>{ to === undefined ? 'No receiving Address' : <SmallAddress addressBookEntry = { to } renameAddressCallBack = { () => undefined } /> }</dd>
					<dt>Value</dt>
					<dd>{ request?.value === undefined ? 'Unknown' : `${ request.value.toString(10) } wei` }</dd>
					<dt>Gas limit </dt>
					<dd>
						<GasLimitEditor transactionIdentifier = { transactionIdentifier } initialGasLimit = { gasLimit } isRawTransaction = { originalRequestParameters.method === 'eth_sendRawTransaction' } />
					</dd>
				</dl>
			</div>
			<div style = 'margin-top: 10px;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Transaction Input</p>
				{ rawRequest === undefined
					? <TransactionInput parsedInputData = { undefined } input = { input } to = { to } addressMetaData = { addressMetaData } renameAddressCallBack = { () => undefined } />
					: <div class = 'textbox'><pre>{ dataStringWith0xStart(rawRequest) }</pre></div>
				}
			</div>
			<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<TransactionCreated created = { created } />
				</div>
				<div class = 'log-cell' style = { { display: 'inline-flex', justifyContent: 'right' } }>
					<SimulatedInBlockNumber
						simulationBlockNumber = { simulationBlockNumber }
						currentBlockNumber = { currentBlockNumber }
						simulationConductedTimestamp = { simulationConductedTimestamp }
						rpcConnectionStatus = { rpcConnectionStatus }
					/>
				</div>
			</span>
		</div>
	</div>
}

export function TransactionCard(param: TransactionCardParams) {
	const renderablePendingTransaction = useComputed(() => getRenderableTransaction(param.currentPendingTransaction.value))
	if (renderablePendingTransaction.value === undefined) return <></>
	return <TransactionCardContent
		currentPendingTransaction = { renderablePendingTransaction }
		pendingTransactionsAndSignableMessages = { param.pendingTransactionsAndSignableMessages }
		renameAddressCallBack = { param.renameAddressCallBack }
		editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
		currentBlockNumber = { param.currentBlockNumber }
		rpcConnectionStatus = { param.rpcConnectionStatus }
		numberOfUnderTransactions = { param.numberOfUnderTransactions }
	/>
}

type TransactionCardContentParams = {
	currentPendingTransaction: ReadonlySignal<SimulatedPendingTransaction | undefined>,
	pendingTransactionsAndSignableMessages: readonly PendingTransactionOrSignableMessage[],
	renameAddressCallBack: RenameAddressCallBack,
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack,
	currentBlockNumber: Signal<bigint | undefined>,
	rpcConnectionStatus: Signal<RpcConnectionStatus>,
	numberOfUnderTransactions: number,
}

function getRenderableTransaction(currentPendingTransaction: PendingTransactionOrSignableMessage | undefined): SimulatedPendingTransaction | undefined {
	if (currentPendingTransaction === undefined || currentPendingTransaction.type !== 'Transaction') return undefined
	if (currentPendingTransaction.transactionOrMessageCreationStatus !== 'Simulated' && currentPendingTransaction.transactionOrMessageCreationStatus !== 'FailedToSimulate') return undefined
	return currentPendingTransaction
}

function getSuccessfulTransactionPopupVisualisation(currentPendingTransaction: SimulatedPendingTransaction | undefined) {
	if (currentPendingTransaction === undefined || currentPendingTransaction.popupVisualisation.statusCode !== 'success') return undefined
	if (currentPendingTransaction.popupVisualisation.data.transactionToSimulate.success === false) return undefined
	return currentPendingTransaction.popupVisualisation
}

function TransactionCardContent(param: TransactionCardContentParams) {
	const currentPendingTransaction = param.currentPendingTransaction.value
	if (currentPendingTransaction === undefined) return <></>
	const popupVisualisation = currentPendingTransaction.popupVisualisation
	const getErrorMesssage = () => {
		if (popupVisualisation.statusCode === 'failed') return `${ popupVisualisation.data.error.decodedErrorMessage } ${ popupVisualisation.data.error.data !== undefined ? ` (data: '${ popupVisualisation.data.error.data }')` : '' }`
		if (!popupVisualisation.data.transactionToSimulate.success) return popupVisualisation.data.transactionToSimulate.error.message
		return 'Unknown error'
	}
	if (popupVisualisation.statusCode === 'failed' || popupVisualisation.data.transactionToSimulate.success === false) {
		return <>
			<FailedTransactionPreviewDetails
				website = { currentPendingTransaction.transactionToSimulate.website }
				transactionIdentifier = { currentPendingTransaction.transactionIdentifier }
				originalRequestParameters = { currentPendingTransaction.originalRequestParameters }
				addressMetaData = { popupVisualisation.statusCode === 'success' ? popupVisualisation.data.addressBookEntries : [] }
				created = { currentPendingTransaction.created }
				errorMessage = { getErrorMesssage() }
				isGasEstimationError = { !popupVisualisation.data.transactionToSimulate.success }
				simulationBlockNumber = { popupVisualisation.data.simulationState.blockNumber }
				simulationConductedTimestamp = { popupVisualisation.data.simulationState.simulationConductedTimestamp }
				rpcConnectionStatus = { param.rpcConnectionStatus }
				currentBlockNumber = { param.currentBlockNumber }
			/>
		</>
	}
	const activeAddress = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.activeAddress)
	const addressMetaData = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.addressBookEntries ?? popupVisualisation.data.addressBookEntries)
	const rpcNetwork = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.simulationState.rpcNetwork ?? popupVisualisation.data.simulationState.rpcNetwork)
	const simulationAndVisualisationResults = {
		blockNumber: popupVisualisation.data.simulationState.blockNumber,
		blockTimestamp: popupVisualisation.data.simulationState.blockTimestamp,
		simulationConductedTimestamp: popupVisualisation.data.simulationState.simulationConductedTimestamp,
		simulationStateInput: popupVisualisation.data.simulationState.simulationStateInput,
		addressBookEntries: popupVisualisation.data.addressBookEntries,
		rpcNetwork: popupVisualisation.data.simulationState.rpcNetwork,
		tokenPriceEstimates: popupVisualisation.data.tokenPriceEstimates,
		visualizedSimulationState: popupVisualisation.data.visualizedSimulationState,
		namedTokenIds: popupVisualisation.data.namedTokenIds,
	}
	const simTx = getResultsForTransaction(popupVisualisation.data.visualizedSimulationState, currentPendingTransaction.transactionIdentifier)
	if (simTx === undefined) return <p> Unable to find simulation results for the transaction</p>
	const simulationBlockNumber = getSimulationDisplayBlockNumber(popupVisualisation.data.simulationState.blockNumber, popupVisualisation.data.visualizedSimulationState.visualizedBlocks.length)
	return <>
		<div class = 'card' style = { `top: ${ param.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
			<TransactionHeader simTx = { simTx } />
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				{ simTx.transactionStatus === 'Failed To Simulate' ? <></> : <>
					<div class = 'container'>
						<TransactionImportanceBlock
							simTx = { simTx }
							activeAddress = { activeAddress }
							rpcNetwork = { rpcNetwork }
							renameAddressCallBack = { param.renameAddressCallBack }
							editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
							addressMetadata = { addressMetaData }
						/>
					</div>
					<QuarantineReasons quarantineReasons = { simTx.quarantineReasons }/>

					<TransactionsAccountChangesCard
						simTx = { simTx }
						simulationAndVisualisationResults = { simulationAndVisualisationResults }
						activeAddress = { activeAddress }
						renameAddressCallBack = { param.renameAddressCallBack }
						addressMetaData = { addressMetaData }
					/>

					<TokenLogAnalysisCard simTx = { simTx } renameAddressCallBack = { param.renameAddressCallBack } />

					<NonTokenLogAnalysisCard
						simTx = { simTx }
						renameAddressCallBack = { param.renameAddressCallBack }
						editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
						addressMetaData = { addressMetaData }
					/>
				</> }

				<RawTransactionDetailsCard isRawTransaction = { simTx.originalRequestParameters.method === 'eth_sendRawTransaction' } transaction = { simTx.transaction } transactionIdentifier = { simTx.transactionIdentifier } parsedInputData = { simTx.parsedInputData } renameAddressCallBack = { param.renameAddressCallBack } gasSpent = { 'gasSpent' in simTx ? simTx.gasSpent : undefined } addressMetaData = { addressMetaData } />

				<SenderReceiver
					from = { simTx.transaction.from }
					to = { simTx.transaction.to }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: max-content auto auto; grid-column-gap: 5px;'>
					<div class = 'log-cell'>
						{ simTx.transactionStatus === 'Failed To Simulate' ? <></> : <>
							<span class = 'log-table' style = { { display: 'inline-flex'} }>
							<GasFee tx = { simTx } rpcNetwork = { rpcNetwork } />
							</span>
						</> }
					</div>
					<div class = 'log-cell' style = 'justify-content: center;'>
						<TransactionCreated created = { currentPendingTransaction.created } />
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { simulationBlockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { popupVisualisation.data.simulationState.simulationConductedTimestamp }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					</div>
				</span>
			</div>
		</div>
	</>
}

type CheckBoxesParams = {
	currentPendingTransactionOrSignableMessage: ReadonlySignal<PendingTransactionOrSignableMessage | undefined>,
	forceSend: Signal<boolean>,
}
const CheckBoxes = (params: CheckBoxesParams) => {
	const current = params.currentPendingTransactionOrSignableMessage.value
	if (current === undefined) return <></>
	if (current?.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	if (current?.type === 'SignableMessage') {
		const visualizedPersonalSignRequest = current.visualizedPersonalSignRequest
		return  <>
			{ isPossibleToSignMessage(visualizedPersonalSignRequest, visualizedPersonalSignRequest.activeAddress.address) && visualizedPersonalSignRequest.quarantine
				? <div style = 'display: grid'>
					<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
						<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend } />
					</div>
				</div>
				: <></>
			}
		</>
	}
	if (current?.popupVisualisation.statusCode !== 'success' || current.popupVisualisation.data.visualizedSimulationState.success === false) return <></>
	const currentResults = getResultsForTransaction(current.popupVisualisation.data.visualizedSimulationState, current.transactionIdentifier)

	const margins = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px;'
	if (currentResults === undefined) return <></>
	if (current?.approvalStatus.status === 'SignerError') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorComponent text = { current.approvalStatus.message } />
		</div>
	</div>
	if (currentResults.transactionStatus !== 'Transaction Succeeded') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorCheckBox text = { 'I understand that the transaction will fail but I want to send it anyway.' } checked = { params.forceSend } />
		</div>
	</div>
	if (currentResults.quarantine === true) return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorCheckBox text = { 'I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.' } checked = { params.forceSend } />
		</div>
	</div>
	return <></>
}

type NetworkErrorParams = {
	currentPendingTransactionOrSignableMessage: ReadonlySignal<PendingTransactionOrSignableMessage | undefined>
}

const WebsiteErrors = ({ currentPendingTransactionOrSignableMessage }: NetworkErrorParams) => {
	const current = currentPendingTransactionOrSignableMessage.value
	if (current === undefined) return <></>
	const message = getWebsiteWarningMessage(current.website.websiteOrigin, current.simulationMode)
	if (message === undefined) return <></>
	if (message.suggestedAlternative === undefined) return <ErrorComponent warning = { true } text = { message.message }/>
	return <ErrorComponent warning = { true } text = { <> { message.message } <Link url = { message.suggestedAlternative } text = { 'Suggested alternative' } websiteSocket = { current.uniqueRequestIdentifier.requestSocket } /> </> }/>
}

type ModalState =
	{ page: 'modifyAddress', state: Signal<ModifyAddressWindowState> } |
	{ page: 'editEns', state: EditEnsNamedHashWindowState } |
	{ page: 'noModal' }

type RejectButtonParams = {
	onClick: () => void
}
const RejectButton = ({ onClick }: RejectButtonParams) => {
	return <div style = 'display: flex;'>
		<button class = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { onClick } >
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

	const signerName = currentPendingTransactionOrSignableMessage.type === 'Transaction' ? currentPendingTransactionOrSignableMessage.popupVisualisation.data.signerName : currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest.signerName
	const identify = () => {
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest)
		const lastTx = currentPendingTransactionOrSignableMessage.popupVisualisation.statusCode !== 'success' || currentPendingTransactionOrSignableMessage.popupVisualisation.data.visualizedSimulationState.success === false ? undefined : getResultsForTransaction(currentPendingTransactionOrSignableMessage.popupVisualisation.data.visualizedSimulationState, currentPendingTransactionOrSignableMessage.transactionIdentifier)
		if (lastTx === undefined) return undefined
		return identifyTransaction(lastTx)
	}
	const identified = identify()
	if (identified === undefined) return <RejectButton onClick = { reject }/>

	return <div style = 'display: flex; flex-direction: row;'>
		<button class = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
			{ identified.rejectAction }
		</button>
		<button class = 'button is-primary button-overflow dialog-button-right' onClick = { approve } disabled = { confirmDisabled }>
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
	const completeVisualizedSimulation = useSignal<CompleteVisualizedSimulation>(createPassthroughCompleteVisualizedSimulation())
	const forceSend = useSignal<boolean>(false)
	const currentBlockNumber = useSignal<undefined | bigint>(undefined)
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const pendingTransactionAddedNotification = useSignal<boolean>(false)
	const unexpectedError = useSignal<CaughtError | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])
	const pendingTransactionsDataPriority = useSignal(0)
	const simulationDataPriority = useSignal(0)
	const networkDataPriority = useSignal(0)

	const applyPendingTransactions = (pendingTransactions: readonly PendingTransactionOrSignableMessage[], priority: number) => {
		if (priority < pendingTransactionsDataPriority.value) return
		pendingTransactionsDataPriority.value = priority
		pendingTransactionsAndSignableMessages.value = pendingTransactions
		const firstMessage = pendingTransactions[0]
		if (firstMessage === undefined) return
		currentPendingTransactionOrSignableMessage.value = firstMessage
		if (firstMessage.type === 'Transaction' && firstMessage.transactionOrMessageCreationStatus === 'Simulating') {
			markPerformanceOnce(POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationStarted)
		}
		if (firstMessage.type === 'Transaction' && (firstMessage.transactionOrMessageCreationStatus === 'Simulated' || firstMessage.transactionOrMessageCreationStatus === 'FailedToSimulate')) {
			markPerformance(POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationReady)
		}
		if (firstMessage.type === 'Transaction' && (firstMessage.transactionOrMessageCreationStatus === 'Simulated' || firstMessage.transactionOrMessageCreationStatus === 'FailedToSimulate') && firstMessage.popupVisualisation !== undefined && firstMessage.popupVisualisation.statusCode === 'success' && (currentBlockNumber.value === undefined || firstMessage.popupVisualisation.data.simulationState.blockNumber > currentBlockNumber.value)) {
			currentBlockNumber.value = firstMessage.popupVisualisation.data.simulationState.blockNumber
		}
	}

	const applyNetworkData = (blockNumber: bigint | undefined, status: RpcConnectionStatus, priority: number) => {
		if (priority < networkDataPriority.value) return
		networkDataPriority.value = priority
		currentBlockNumber.value = blockNumber
		rpcConnectionStatus.value = status
	}

	const updatePendingTransactionsAndSignableMessages = (message: UpdateConfirmTransactionDialog) => {
		if (CONFIRM_TRANSACTION_DATA_PRIORITY.push < simulationDataPriority.value) return
		simulationDataPriority.value = CONFIRM_TRANSACTION_DATA_PRIORITY.push
		completeVisualizedSimulation.value = message.data.visualizedSimulatorState
		applyNetworkData(message.data.currentBlockNumber, message.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
	}
	useEffect(() => {
		function popupMessageListener(msg: unknown): false {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value

			if (parsed.method === 'popup_settingsUpdated') {
				sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
				return false
			}
			if (parsed.method === 'popup_requestSettingsReply') {
				rpcEntries.value = parsed.data.rpcEntries
				return false
			}
			if (parsed.method === 'popup_UnexpectedErrorOccured') {
				unexpectedError.value = parsed.data
				return false
			}
			if (parsed.method === 'popup_addressBookEntriesChanged') {
				refreshMetadata()
				return false
			}
			if (parsed.method === 'popup_new_block_arrived') {
				applyNetworkData(parsed.data.rpcConnectionStatus?.latestBlock?.number, parsed.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				refreshPopupVisualisationIfNeeded()
				return false
			}
			if (parsed.method === 'popup_failed_to_get_block') {
				applyNetworkData(parsed.data.rpcConnectionStatus?.latestBlock?.number, parsed.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				return false
			}
			if (parsed.method === 'popup_confirm_transaction_simulation_started') {
				markPerformanceOnce(POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationStarted)
				return false
			}
			if (parsed.method === 'popup_update_confirm_transaction_dialog') {
				const { role: _role, ...popupUpdateConfirmTransactionDialog } = parsed
				updatePendingTransactionsAndSignableMessages(UpdateConfirmTransactionDialog.parse(popupUpdateConfirmTransactionDialog))
				return false
			}
			if (parsed.method === 'popup_update_confirm_transaction_dialog_pending_transactions') {
				const { role: _role, ...popupUpdateConfirmTransactionDialogPendingTransactions } = parsed
				const updateConfirmTransactionDialogPendingTransactions = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdateConfirmTransactionDialogPendingTransactions)
				applyNetworkData(updateConfirmTransactionDialogPendingTransactions.data.currentBlockNumber, updateConfirmTransactionDialogPendingTransactions.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				const firstMessage = updateConfirmTransactionDialogPendingTransactions.data.pendingTransactionAndSignableMessages[0]
				if (firstMessage === undefined) throw new Error('message data was undefined')
				applyPendingTransactions(updateConfirmTransactionDialogPendingTransactions.data.pendingTransactionAndSignableMessages, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
			}
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		let cancelled = false
		const applyBootstrapData = (bootstrapData: ConfirmTransactionBootstrapData) => {
			if (cancelled) return
			applyPendingTransactions(bootstrapData.pendingTransactionAndSignableMessages, CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap)
			if (CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap >= simulationDataPriority.value) {
				simulationDataPriority.value = CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap
				completeVisualizedSimulation.value = bootstrapData.visualizedSimulatorState
			}
			applyNetworkData(bootstrapData.currentBlockNumber, bootstrapData.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap)
		}
		void hydratePendingTransactionsFromStorage().then((pendingTransactions) => {
			if (cancelled || pendingTransactions.length === 0) return
			applyPendingTransactions(pendingTransactions, CONFIRM_TRANSACTION_DATA_PRIORITY.storage)
		})
		void sendPopupMessageWithReply({ method: 'popup_readyAndListening', data: { page: 'confirmTransaction' } }).then((reply) => {
			if (cancelled || reply?.method !== 'popup_readyAndListening') return
			const bootstrapData = reply.data.confirmTransactionBootstrap
			if (bootstrapData === undefined) return
			applyBootstrapData(bootstrapData)
		})
		void bootstrapConfirmTransactionDialog(() => cancelled || currentPendingTransactionOrSignableMessage.value !== undefined, applyBootstrapData)
		sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
		return () => {
			cancelled = true
		}
	}, [])

	async function approve() {
		if (currentPendingTransactionOrSignableMessage.value === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		const deliveryError = await sendConfirmDialogMessage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier, action: 'accept' } })
		if (deliveryError !== undefined) unexpectedError.value = deliveryError
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
			if (pending.popupVisualisation.statusCode !== 'success' ) return undefined
			if (pending.popupVisualisation.data.visualizedSimulationState.success === false) return undefined
			const results = getResultsForTransaction(pending.popupVisualisation.data.visualizedSimulationState, pending.transactionIdentifier)
			if (results === undefined) return undefined
			return results.transactionStatus !== 'Transaction Succeeded' ? results.error.message : undefined
		}

		const deliveryError = await sendConfirmDialogMessage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier,
			action: 'reject',
			errorString: getPossibleErrorString(),
		} })
		if (deliveryError !== undefined) unexpectedError.value = deliveryError
	}
	const refreshMetadata = async () => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata'})
	}
	const refreshPopupVisualisationIfNeeded = async () => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation' })
	}

	const isConfirmDisabled = useComputed(() => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return true
		if (currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated') return true
		if (currentPendingTransactionOrSignableMessage.value.type !== 'Transaction') {
			return shouldDisableSignableMessageConfirm({
				isValidMessage: currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest.isValidMessage === true,
				canSignMessage: isPossibleToSignMessage(currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest, currentPendingTransactionOrSignableMessage.value.activeAddress),
				forceSendEnabled: forceSend.value,
				hasSupportedRpc: currentPendingTransactionOrSignableMessage.value.visualizedPersonalSignRequest.rpcNetwork.httpsRpc !== undefined,
			})
		}
		if (forceSend.value) return false
		if (currentPendingTransactionOrSignableMessage.value.popupVisualisation === undefined) return true
		if (currentPendingTransactionOrSignableMessage.value.popupVisualisation.statusCode !== 'success') return true
		if (currentPendingTransactionOrSignableMessage.value.approvalStatus.status === 'WaitingForSigner') return true
		if (currentPendingTransactionOrSignableMessage.value.popupVisualisation.data.visualizedSimulationState.success === false) return true
		const lastTx = getResultsForTransaction(currentPendingTransactionOrSignableMessage.value.popupVisualisation.data.visualizedSimulationState, currentPendingTransactionOrSignableMessage.value.transactionIdentifier)
		if (lastTx === undefined) return true
		if (lastTx.transactionStatus !== 'Transaction Succeeded') return true
		if (lastTx.quarantine) return true
		return false
	})

	function getCurrentAddressBookEntries() {
		const current = currentPendingTransactionOrSignableMessage.value
		if (current?.type === 'Transaction' && current.transactionOrMessageCreationStatus === 'Simulated' && current.popupVisualisation.statusCode === 'success') {
			return current.popupVisualisation.data.addressBookEntries
		}
		return completeVisualizedSimulation.value.addressBookEntries
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		modalState.value = { page: 'modifyAddress', state: new Signal(addressEditEntry(getAddressBookEntryForEdit(entry, getCurrentAddressBookEntries()))) }
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
		if ('popupVisualisation' in current && current.popupVisualisation?.statusCode === 'failed') return 'Failed to simulate. Retrying...'
		return 'Loading...'
	}
	const loadingText = useComputed(() => getLoadingText(currentPendingTransactionOrSignableMessage.value))

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		await sendPopupMessageToBackgroundPage( { method: 'popup_clearUnexpectedError' } )
	}

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
						{ modalState.value.page === 'modifyAddress' ?
							<AddNewAddress
								setActiveAddressAndInformAboutIt = { undefined }
								modifyAddressWindowState = { modalState.value.state }
								close = { () => { modalState.value = { page: 'noModal' } } }
								activeAddress = { currentPendingTransactionOrSignableMessage.value?.activeAddress }
								rpcEntries = { rpcEntries }
							/>
						: <></> }
					</div>
					<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px;'>
						<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						<WebsiteErrors currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage }/>
						<InvalidMessage pendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage }/>
							<CenterToPageTextSpinner text = { loadingText }/>
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
					{ modalState.value.page === 'modifyAddress' ?
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							modifyAddressWindowState = { modalState.value.state }
							close = { () => { modalState.value = { page: 'noModal' } } }
							activeAddress = { currentPendingTransactionOrSignableMessage.value?.activeAddress }
							rpcEntries = { rpcEntries }
						/>
					: <></> }
				</div>
				<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
					<div style = 'position: sticky; top: 0; z-index: 1;'>
						<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError.value }/>
						<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
						<WebsiteErrors currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage }/>
						<InvalidMessage pendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage }/>
					</div>
					<div class = 'popup-contents'>
						<div style = 'margin: 10px'>
							{ currentPendingTransactionOrSignableMessage.value.originalRequestParameters.method === 'eth_sendRawTransaction' && currentPendingTransactionOrSignableMessage.value.type === 'Transaction'
								? <DinoSaysNotification
									text = { `This transaction is signed already. No extra signing required to forward it to ${ currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated' || currentPendingTransactionOrSignableMessage.value.popupVisualisation.statusCode === 'failed' ?
									'network' :
									currentPendingTransactionOrSignableMessage.value.popupVisualisation.data.simulationState.rpcNetwork.name }.` }
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
							<div style = 'margin-bottom: 10px;'>
								<TransactionNames completeVisualizedSimulation = { completeVisualizedSimulation } currentPendingTransaction = { currentPendingTransactionOrSignableMessage } includeCurrentTransaction = { true }/>
							</div>
							<UnderTransactions pendingTransactionsAndSignableMessages = { underTransactions }/>
							<div style = { `top: ${ underTransactions.value.length * -HALF_HEADER_HEIGHT }px` }></div>
							{ currentPendingTransactionOrSignableMessage.value.type === 'Transaction' ?
								<TransactionCard
									currentPendingTransaction = { currentPendingTransactionOrSignableMessage }
									pendingTransactionsAndSignableMessages = { pendingTransactionsAndSignableMessages.value }
									renameAddressCallBack = { renameAddressCallBack }
									editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
									currentBlockNumber = { currentBlockNumber }
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
							<CheckBoxes currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage } forceSend = { forceSend } />
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
