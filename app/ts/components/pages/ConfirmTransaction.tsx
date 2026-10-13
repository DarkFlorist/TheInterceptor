import { SafeProposalDetails, SafeProposalSigningRequestCard } from './SafeProposalDetails.js'
import { useCallback, useEffect } from 'preact/hooks'
import { type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
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
import type { PendingTransaction, PopupPendingTransactionOrSignableMessage as PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../../types/accessRequest.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { SmallAddress } from '../subcomponents/address.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import type { EthereumBytes32 } from '../../types/wire-types.js'
import type { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import { getWebsiteWarningMessage } from '../../utils/websiteData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { Link } from '../subcomponents/link.js'
import { NetworkErrors } from '../subcomponents/NetworkErrors.js'
import { identifySignature } from '../simulationExplaining/identifySignature.js'
import { InvalidMessage, SignatureCard, SignatureHeader, isPossibleToSignMessage } from './PersonalSign.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { EditEnsLabelHash } from './EditEnsLabelHash.js'
import { type ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import type { RpcEntries } from '../../types/rpc.js'
import { usePopupMessage } from '../hooks/usePopupMessage.js'
import { usePopupSettingsSnapshot } from '../hooks/usePopupSettingsSnapshot.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance, markPerformanceOnce } from '../../utils/popupPerformance.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { bigintToDecimalString, dataStringWith0xStart } from '../../utils/bigint.js'
import { browserStorageLocalGet2 } from '../../utils/storageUtils.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { type AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton, AsyncStatusIcon } from '../subcomponents/AsyncAction.js'
import type { SignerName } from '../../types/signerTypes.js'
import { assertNever } from '../../utils/typescript.js'
import { getSafeTransactionPendingFlow } from '../../safe/safePendingFlow.js'

type UnderTransactionsParams = {
	pendingTransactionsAndSignableMessages: ReadonlySignal<PendingTransactionOrSignableMessage[]>
}

export const CONFIRM_TRANSACTION_BOOTSTRAP_RETRY_DELAY_MS = 150
const CONFIRM_TRANSACTION_BOOTSTRAP_MAX_ATTEMPTS = 10
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

async function bootstrapConfirmTransactionDialog(
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

// Returns the simulated transaction of a pending transaction, or undefined for messages, unfinished or failed simulations and missing results.
function findSimulatedTransactionForPendingEntry(pending: PendingTransactionOrSignableMessage | undefined) {
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') return undefined
	if (pending.popupVisualisation.statusCode !== 'success') return undefined
	const visualizedSimulationState = pending.popupVisualisation.data.visualizedSimulationState
	if (!visualizedSimulationState.success) return undefined
	const transactionIdentifier = pending.transactionIdentifier
	return visualizedSimulationState.visualizedBlocks
		.flatMap((block) => block.simulatedAndVisualizedTransactions)
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
	} catch (error) {
		const errorMessage = await reportUnexpectedError(error, {
			source: 'confirmTransaction',
			code: 'confirm_dialog_delivery_failed',
			displayMessage: getConfirmDialogDeliveryErrorMessage(error),
			suppressExpectedHandledErrors: false,
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
				const simTx = findSimulatedTransactionForPendingEntry(pendingTransaction)
				return <div key = { stackItemKey } class = 'card' style = { style }>
					{ simTx === undefined
						? <TransactionHeaderForFailedToSimulate website = { pendingTransaction.transactionToSimulate.website } />
						: <TransactionHeader simTx = { simTx } />
					}
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

export function getTransactionStatusLabel(status: PendingTransactionOrSignableMessage['transactionOrMessageCreationStatus']) {
	if (status === 'FailedToSimulate') return 'Simulation failed'
	return status
}

export const TransactionNames = (param: TransactionNamesParams) => {
	const titleOfCurrentPendingTransaction = () => {
		const currentPendingTransactionOrSignableMessage = param.currentPendingTransaction.value
		if (currentPendingTransactionOrSignableMessage === undefined) return 'Loading...'
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return getTransactionStatusLabel(currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus)
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest).title
		if (currentPendingTransactionOrSignableMessage.popupVisualisation.statusCode === 'failed') return 'Failing transaction'
		const lastTx = findSimulatedTransactionForPendingEntry(currentPendingTransactionOrSignableMessage)
		if (lastTx === undefined) return 'Could not find transaction...'
		return identifyTransaction(lastTx).title
	}

	// Computed during render because includeCurrentTransaction is a plain prop that a cached computed would not track.
	const getNamesWithCurrentTransaction = () => {
		if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough' || param.completeVisualizedSimulation.value.visualizedSimulationState.success === false) return []
		const visualizedBlocks = param.completeVisualizedSimulation.value.visualizedSimulationState.visualizedBlocks
		const transactionsAndMessages = visualizedBlocks.flatMap((block) => [...block.visualizedPersonalSignRequests, ...block.simulatedAndVisualizedTransactions])
		const names = transactionsAndMessages.map((transactionOrMessage) => 'transaction' in transactionOrMessage ? identifyTransaction(transactionOrMessage).title : identifySignature(transactionOrMessage).title)
		return [...param.completeVisualizedSimulation.value.numberOfAddressesMadeRich > 0 ? [`Simply making ${ param.completeVisualizedSimulation.value.numberOfAddressesMadeRich } addresses rich`] : [], ...names, ...param.includeCurrentTransaction ? [titleOfCurrentPendingTransaction()] : [] ]
	}

	if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough') return <></>
	const namesWithCurrentTransaction = getNamesWithCurrentTransaction()

	return <nav class = 'breadcrumb has-succeeds-separator is-small'>
		<ul>
			{ namesWithCurrentTransaction.map((name, index) => (
				<li key = { `${ index }-${ name }` } style = 'margin: 0px;'>
					<div class = 'card' style = { `padding: 5px; margin: 5px; ${ index !== namesWithCurrentTransaction.length - 1 && param.includeCurrentTransaction ? 'background-color: var(--disabled-card-color)' : ''}` }>
						<p class = 'paragraph' style = { `margin: 0px; ${ index !== namesWithCurrentTransaction.length - 1 && param.includeCurrentTransaction ? 'color: var(--disabled-text-color)' : ''}` }>
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
	renameAddressCallBack,
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
	renameAddressCallBack: RenameAddressCallBack
}) {
	const request = originalRequestParameters.method === 'eth_sendTransaction' ? originalRequestParameters.params[0] : undefined
	const rawRequest = originalRequestParameters.method === 'eth_sendRawTransaction' ? originalRequestParameters.params[0] : undefined
	const from = request?.from === undefined ? undefined : getAddressBookEntryOrAFiller(addressMetaData, request.from)
	const to = request?.to === null || request?.to === undefined ? undefined : getAddressBookEntryOrAFiller(addressMetaData, request.to)
	const input = request === undefined ? new Uint8Array() : request.input ?? request.data ?? new Uint8Array()
	const gasLimit = request?.gas

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header failed-transaction-header'>
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
					<dd>{ from === undefined ? 'Unknown' : <SmallAddress addressBookEntry = { from } renameAddressCallBack = { renameAddressCallBack } /> }</dd>
					<dt>To</dt>
					<dd>{ to === undefined ? 'No receiving Address' : <SmallAddress addressBookEntry = { to } renameAddressCallBack = { renameAddressCallBack } /> }</dd>
					<dt>Value</dt>
					<dd>{ request === undefined ? 'Unknown' : `${ bigintToDecimalString(request.value ?? 0n, 18n) } ether` }</dd>
					<dt>Gas limit </dt>
					<dd>
						<GasLimitEditor transactionIdentifier = { transactionIdentifier } initialGasLimit = { gasLimit } isRawTransaction = { originalRequestParameters.method === 'eth_sendRawTransaction' } />
					</dd>
				</dl>
			</div>
			<div style = 'margin-top: 10px;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Transaction Input</p>
				{ rawRequest === undefined
					? <TransactionInput parsedInputData = { undefined } input = { input } to = { to } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack } />
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

function TransactionCard(param: TransactionCardParams) {
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
		const addressMetaData = popupVisualisation.statusCode === 'success' ? popupVisualisation.data.addressBookEntries : []
		const safeFlow = getSafeTransactionPendingFlow(currentPendingTransaction)
		return <>
			<FailedTransactionPreviewDetails
				website = { currentPendingTransaction.transactionToSimulate.website }
				transactionIdentifier = { currentPendingTransaction.transactionIdentifier }
				originalRequestParameters = { currentPendingTransaction.originalRequestParameters }
				addressMetaData = { addressMetaData }
				created = { currentPendingTransaction.created }
				errorMessage = { getErrorMesssage() }
				isGasEstimationError = { !popupVisualisation.data.transactionToSimulate.success }
				simulationBlockNumber = { popupVisualisation.data.simulationState.blockNumber }
				simulationConductedTimestamp = { popupVisualisation.data.simulationState.simulationConductedTimestamp }
				rpcConnectionStatus = { param.rpcConnectionStatus }
				currentBlockNumber = { param.currentBlockNumber }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			{ safeFlow?.kind !== 'proposal' ? <></> : <SafeProposalSigningRequestCard
				safeTransaction = { safeFlow.pending.safeTransaction }
				addressMetaData = { addressMetaData }
				rpcNetwork = { popupVisualisation.statusCode === 'success' ? popupVisualisation.data.simulationState.rpcNetwork : undefined }
				renameAddressCallBack = { param.renameAddressCallBack }
			/> }
		</>
	}
	return <SuccessfulTransactionCardContent { ...param } simulatedPendingTransaction = { currentPendingTransaction } successfulPopupVisualisation = { popupVisualisation } />
}

type SuccessfulTransactionCardContentParams = TransactionCardContentParams & {
	simulatedPendingTransaction: SimulatedPendingTransaction,
	successfulPopupVisualisation: NonNullable<ReturnType<typeof getSuccessfulTransactionPopupVisualisation>>,
}

function SuccessfulTransactionCardContent(param: SuccessfulTransactionCardContentParams) {
	const activeAddress = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.activeAddress)
	const addressMetaData = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.addressBookEntries ?? param.successfulPopupVisualisation.data.addressBookEntries)
	const rpcNetwork = useComputed(() => getSuccessfulTransactionPopupVisualisation(param.currentPendingTransaction.value)?.data.simulationState.rpcNetwork ?? param.successfulPopupVisualisation.data.simulationState.rpcNetwork)
	const currentPendingTransaction = param.simulatedPendingTransaction
	const popupVisualisation = param.successfulPopupVisualisation
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
	// Unlike findSimulatedTransactionForPendingEntry this also returns 'Failed To Simulate' entries, which the card still renders.
	const simTx = getResultsForTransaction(popupVisualisation.data.visualizedSimulationState, currentPendingTransaction.transactionIdentifier)
	if (simTx === undefined) return <p> Unable to find simulation results for the transaction</p>
	const safeFlow = getSafeTransactionPendingFlow(currentPendingTransaction)
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

				{ safeFlow?.kind !== 'proposal' ? <></> : <SafeProposalSigningRequestCard
					safeTransaction = { safeFlow.pending.safeTransaction }
					addressMetaData = { addressMetaData.value }
					rpcNetwork = { rpcNetwork.value }
					renameAddressCallBack = { param.renameAddressCallBack }
				/> }

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
	addressBookEntries?: readonly AddressBookEntry[],
}

function SafeSignerErrorAddress({ label, address, addressBookEntries }: { label: string, address: bigint, addressBookEntries: readonly AddressBookEntry[] }) {
	return <>
		<dt>{ label }</dt>
		<dd><SmallAddress addressBookEntry = { getAddressBookEntryOrAFiller(addressBookEntries, address) } renameAddressCallBack = { () => undefined } noEditAddress = { true } /></dd>
	</>
}

function SafeSignerErrorDetails({ details, addressBookEntries }: {
	details: NonNullable<Extract<PendingTransactionOrSignableMessage['approvalStatus'], { status: 'SignerError' }>['safeSignerErrorDetails']>,
	addressBookEntries: readonly AddressBookEntry[],
}) {
	switch (details.kind) {
		case 'safeSigningAccountMismatch':
			addressBookEntries = [...details.safeOwnerAddressBookEntries, ...addressBookEntries]
			return <dl class = 'safe-signer-error-details'>
				<SafeSignerErrorAddress label = 'Signing account' address = { details.requestedSigningAccount } addressBookEntries = { addressBookEntries } />
				<SafeSignerErrorAddress label = 'Active Safe' address = { details.activeSafe } addressBookEntries = { addressBookEntries } />
				{ details.requestedSafe === details.activeSafe ? <></> : <SafeSignerErrorAddress label = 'Transaction Safe' address = { details.requestedSafe } addressBookEntries = { addressBookEntries } /> }
				<dt>Safe owners</dt>
				<dd class = 'safe-signer-error-owner-list'>
					{ details.safeOwnersUnavailableReason !== undefined
						? <span>Owners unavailable: { details.safeOwnersUnavailableReason }</span>
						: details.safeOwners.length === 0
						? <span>No owners found</span>
						: details.safeOwners.map((owner) => <SmallAddress key = { owner.toString() } addressBookEntry = { getAddressBookEntryOrAFiller(addressBookEntries, owner) } renameAddressCallBack = { () => undefined } noEditAddress = { true } />)
					}
				</dd>
			</dl>
		case 'safeOwnerMismatch':
			return <dl class = 'safe-signer-error-details'>
				<SafeSignerErrorAddress label = 'Expected owner' address = { details.expectedOwner } addressBookEntries = { addressBookEntries } />
				<dt>Wallet account</dt>
				<dd>{ details.walletAccount === undefined
					? <span>No account selected</span>
					: <SmallAddress addressBookEntry = { getAddressBookEntryOrAFiller(addressBookEntries, details.walletAccount) } renameAddressCallBack = { () => undefined } noEditAddress = { true } />
				}</dd>
			</dl>
		default: assertNever(details)
	}
}

export const CheckBoxes = (params: CheckBoxesParams) => {
	const current = params.currentPendingTransactionOrSignableMessage.value
	if (current === undefined) return <></>
	if (current?.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	const margins = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px;'
	const visualizedAddressBookEntries = current.type === 'SignableMessage'
		? [
			current.visualizedPersonalSignRequest.account,
			current.visualizedPersonalSignRequest.activeAddress,
			...(current.visualizedPersonalSignRequest.type === 'SafeTx' ? [current.visualizedPersonalSignRequest.verifyingContract, ...current.visualizedPersonalSignRequest.parsedMessageDataAddressBookEntries] : []),
		]
		: []
	const addressBookEntries = [...visualizedAddressBookEntries, ...(params.addressBookEntries ?? [])]
	if (current.approvalStatus.status === 'SignerError') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorComponent text = { current.approvalStatus.message } />
			{ current.approvalStatus.safeSignerErrorDetails === undefined
				? <></>
				: <SafeSignerErrorDetails details = { current.approvalStatus.safeSignerErrorDetails } addressBookEntries = { addressBookEntries } />
			}
		</div>
	</div>
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
	const currentResults = findSimulatedTransactionForPendingEntry(current)
	if (currentResults === undefined) return <></>
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

function ConfirmTransactionModal({ modalState, activeAddress, rpcEntries }: {
	modalState: Signal<ModalState>
	activeAddress: bigint | undefined
	rpcEntries: ReadonlySignal<RpcEntries>
}) {
	const close = () => {
		modalState.value = { page: 'noModal' }
	}
	return <div class = { `modal ${ modalState.value.page !== 'noModal' ? 'is-active' : ''}` }>
		{ modalState.value.page === 'editEns' ?
			<EditEnsLabelHash
				close = { close }
				editEnsNamedHashWindowState = { modalState.value.state }
			/>
		: <></> }
		{ modalState.value.page === 'modifyAddress' ?
			<AddNewAddress
				setActiveAddressAndInformAboutIt = { undefined }
				modifyAddressWindowState = { modalState.value.state }
				close = { close }
				activeAddress = { activeAddress }
				rpcEntries = { rpcEntries }
			/>
		: <></> }
	</div>
}

function ConfirmTransactionAlerts({ unexpectedError, clearUnexpectedError, rpcConnectionStatus, currentPendingTransaction }: {
	unexpectedError: CaughtError | undefined
	clearUnexpectedError: () => Promise<void>
	rpcConnectionStatus: ReadonlySignal<RpcConnectionStatus>
	currentPendingTransaction: ReadonlySignal<PendingTransactionOrSignableMessage | undefined>
}) {
	return <>
		<UnexpectedError close = { clearUnexpectedError } error = { unexpectedError }/>
		<NetworkErrors rpcConnectionStatus = { rpcConnectionStatus }/>
		<WebsiteErrors currentPendingTransactionOrSignableMessage = { currentPendingTransaction }/>
		<InvalidMessage pendingTransactionOrSignableMessage = { currentPendingTransaction }/>
	</>
}

type RejectButtonParams = {
	onClick: () => void | Promise<void>
	state: AsyncStates
}
const RejectButton = ({ onClick, state }: RejectButtonParams) => {
	return <div style = 'display: flex;'>
		<AsyncActionButton
			class = 'button is-primary is-danger button-overflow dialog-button-left'
			state = { state }
			text = { 'Reject' }
			pendingText = { 'Rejecting...' }
			onClick = { onClick }
		/>
	</div>
}

type ButtonsParams = {
	currentPendingTransactionOrSignableMessage: PendingTransactionOrSignableMessage | undefined
	reject: () => void
	rejectButtonState: AsyncStates
	approve: () => void
	approveButtonState: AsyncStates
	confirmDisabled: boolean
	addToSafeStack?: () => void
	addToSafeStackButtonState?: AsyncStates
	addToSafeStackDisabled?: boolean
}

type ConfirmationActionButtonsParams = Omit<ButtonsParams, 'currentPendingTransactionOrSignableMessage'> & {
	identified: {
		signingAction: string
		simulationAction: string
		rejectAction: string
	}
	signerName: SignerName
	simulationMode: boolean
	waitingForSigner: boolean
}

export function ConfirmationActionButtons({ identified, signerName, simulationMode, waitingForSigner, reject, rejectButtonState, approve, approveButtonState, confirmDisabled, addToSafeStack, addToSafeStackButtonState = 'inactive', addToSafeStackDisabled = true }: ConfirmationActionButtonsParams) {
	const addsSafeProposal = addToSafeStack !== undefined && !simulationMode
	return <div class = 'confirmation-action-buttons-container'>
		<div class = { `confirmation-action-buttons${ addsSafeProposal ? ' confirmation-action-buttons--safe' : '' }` }>
			<AsyncActionButton
				class = 'button is-primary is-danger button-overflow dialog-action-button'
				state = { rejectButtonState }
				disabled = { approveButtonState === 'pending' || addToSafeStackButtonState === 'pending' }
				text = { identified.rejectAction }
				pendingText = 'Rejecting...'
				onClick = { reject }
			/>
			{ addToSafeStack === undefined ? <></> : <AsyncActionButton
				class = 'button button--secondary button-overflow dialog-action-button'
				state = { addToSafeStackButtonState }
				disabled = { addToSafeStackDisabled || rejectButtonState === 'pending' || approveButtonState === 'pending' }
				ariaLabel = 'Add unsigned to Safe stack'
				pendingAriaLabel = 'Adding unsigned proposal to Safe stack...'
				title = 'Add this proposal to the Safe stack without a signature'
				text = 'Add unsigned'
				pendingText = 'Adding unsigned...'
				onClick = { addToSafeStack }
			/> }
			<AsyncActionButton
				class = 'button is-primary button-overflow dialog-action-button'
				state = { approveButtonState }
				ariaLabel = { addsSafeProposal ? 'Sign and add to Safe stack' : undefined }
				pendingAriaLabel = { addsSafeProposal ? 'Signing and adding proposal to Safe stack...' : undefined }
				title = { addsSafeProposal ? 'Sign this proposal and add it to the Safe stack' : undefined }
				text = { waitingForSigner
					? <span class = 'confirmation-waiting-for-signer'>
						<AsyncStatusIcon state = 'pending'/>
						<span>Waiting for{ ' ' }</span>
						<SignersLogoName signerName = { signerName }/>
					</span>
					: simulationMode
						? `${ identified.simulationAction }!`
						: <SignerLogoText signerName = { signerName } text = { addsSafeProposal ? 'Sign & add' : identified.signingAction } />
				}
				pendingText = { waitingForSigner
					? 'Waiting for signer...'
					: simulationMode
						? `${ identified.simulationAction }...`
						: addsSafeProposal ? 'Signing & adding...' : `Sign with ${ signerName }...`
				}
				onClick = { approve }
				disabled = { confirmDisabled || rejectButtonState === 'pending' || addToSafeStackButtonState === 'pending' }
			/>
		</div>
	</div>
}

export const shouldDisableConfirmForApprovalStatus = (approvalStatus: PendingTransactionOrSignableMessage['approvalStatus']) => approvalStatus.status === 'WaitingForSigner'

function ConfirmationButtons({ currentPendingTransactionOrSignableMessage, reject, rejectButtonState, approve, approveButtonState, confirmDisabled, addToSafeStack, addToSafeStackButtonState, addToSafeStackDisabled }: ButtonsParams) {
	if (currentPendingTransactionOrSignableMessage === undefined) return <RejectButton onClick = { reject } state = { rejectButtonState }/>
	if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return <RejectButton onClick = { reject } state = { rejectButtonState }/>

	const signerName = currentPendingTransactionOrSignableMessage.type === 'Transaction' ? currentPendingTransactionOrSignableMessage.popupVisualisation.data.signerName : currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest.signerName
	const identify = () => {
		if (currentPendingTransactionOrSignableMessage.type === 'SignableMessage') return identifySignature(currentPendingTransactionOrSignableMessage.visualizedPersonalSignRequest)
		const lastTx = findSimulatedTransactionForPendingEntry(currentPendingTransactionOrSignableMessage)
		if (lastTx === undefined) return undefined
		return identifyTransaction(lastTx)
	}
	const identified = identify()
	if (identified === undefined) return <RejectButton onClick = { reject } state = { rejectButtonState }/>

	return <ConfirmationActionButtons
		identified = { identified }
		signerName = { signerName }
		simulationMode = { currentPendingTransactionOrSignableMessage.simulationMode }
		waitingForSigner = { currentPendingTransactionOrSignableMessage.approvalStatus.status === 'WaitingForSigner' }
		reject = { reject }
		rejectButtonState = { rejectButtonState }
		approve = { approve }
		approveButtonState = { approveButtonState }
		confirmDisabled = { confirmDisabled }
		addToSafeStack = { addToSafeStack }
		addToSafeStackButtonState = { addToSafeStackButtonState }
		addToSafeStackDisabled = { addToSafeStackDisabled }
	/>
}

// Owns the confirmation dialog's data: pending requests, simulation and network state, pushed updates and the startup bootstrap.
function useConfirmTransactionDialogData() {
	const currentPendingTransactionOrSignableMessage = useSignal<PendingTransactionOrSignableMessage | undefined>(undefined)
	const pendingTransactionsAndSignableMessages = useSignal<readonly PendingTransactionOrSignableMessage[]>([])
	const completeVisualizedSimulation = useSignal<CompleteVisualizedSimulation>(createPassthroughCompleteVisualizedSimulation())
	const currentBlockNumber = useSignal<undefined | bigint>(undefined)
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const pendingTransactionAddedNotification = useSignal<boolean>(false)
	const unexpectedError = useSignal<CaughtError | undefined>(undefined)
	const settingsSnapshot = usePopupSettingsSnapshot()
	const rpcEntries = useComputed(() => settingsSnapshot.value?.rpcEntries ?? [])
	const pendingTransactionsDataPriority = useSignal(0)
	const simulationDataPriority = useSignal(0)
	const networkDataPriority = useSignal(0)

	// The apply functions only write this hook's signals, so useCallback keeps them stable and the bootstrap effect below runs once per mount.
	const applyPendingTransactions = useCallback((pendingTransactions: readonly PendingTransactionOrSignableMessage[], priority: number) => {
		// An empty queue has nothing to show; keep the last request visible until the background closes this dialog.
		const firstMessage = pendingTransactions[0]
		if (firstMessage === undefined) return
		if (priority < pendingTransactionsDataPriority.value) return
		pendingTransactionsDataPriority.value = priority
		const previousPendingTransactions = pendingTransactionsAndSignableMessages.value
		pendingTransactionsAndSignableMessages.value = pendingTransactions
		if (previousPendingTransactions.length > 0 && pendingTransactions.length > previousPendingTransactions.length) pendingTransactionAddedNotification.value = true
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
	}, [])

	const applySimulationState = useCallback((visualizedSimulatorState: CompleteVisualizedSimulation, priority: number) => {
		if (priority < simulationDataPriority.value) return
		simulationDataPriority.value = priority
		completeVisualizedSimulation.value = visualizedSimulatorState
	}, [])

	const applyNetworkData = useCallback((blockNumber: bigint | undefined, status: RpcConnectionStatus, priority: number) => {
		if (priority < networkDataPriority.value) return
		networkDataPriority.value = priority
		currentBlockNumber.value = blockNumber
		rpcConnectionStatus.value = status
	}, [])

	const refreshMetadata = async () => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionMetadata'})
	}
	const refreshPopupVisualisationIfNeeded = async () => {
		if (currentPendingTransactionOrSignableMessage.value === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_refreshConfirmTransactionDialogSimulation' })
	}

	usePopupMessage(async (message) => {
		switch (message.method) {
			case 'popup_UnexpectedErrorOccured':
				unexpectedError.value = message.data
				return
			case 'popup_addressBookEntriesChanged':
				await refreshMetadata()
				return
			case 'popup_new_block_arrived':
				applyNetworkData(message.data.rpcConnectionStatus?.latestBlock?.number, message.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				await refreshPopupVisualisationIfNeeded()
				return
			case 'popup_failed_to_get_block':
			case 'popup_rpc_connection_status_changed':
				applyNetworkData(message.data.rpcConnectionStatus?.latestBlock?.number, message.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				return
			case 'popup_confirm_transaction_simulation_started':
				markPerformanceOnce(POPUP_PERFORMANCE_MARKS.confirmTransactionSimulationStarted)
				return
			case 'popup_update_confirm_transaction_dialog': {
				const { role: _role, ...popupUpdateConfirmTransactionDialog } = message
				const update = UpdateConfirmTransactionDialog.parse(popupUpdateConfirmTransactionDialog)
				applySimulationState(update.data.visualizedSimulatorState, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				applyNetworkData(update.data.currentBlockNumber, update.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				return
			}
			case 'popup_update_confirm_transaction_dialog_pending_transactions': {
				const { role: _role, ...popupUpdateConfirmTransactionDialogPendingTransactions } = message
				const update = UpdateConfirmTransactionDialogPendingTransactions.parse(popupUpdateConfirmTransactionDialogPendingTransactions)
				applyNetworkData(update.data.currentBlockNumber, update.data.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				applyPendingTransactions(update.data.pendingTransactionAndSignableMessages, CONFIRM_TRANSACTION_DATA_PRIORITY.push)
				return
			}
		}
	})

	useEffect(() => {
		let cancelled = false
		const applyBootstrapData = (bootstrapData: ConfirmTransactionBootstrapData) => {
			if (cancelled) return
			applyPendingTransactions(bootstrapData.pendingTransactionAndSignableMessages, CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap)
			applySimulationState(bootstrapData.visualizedSimulatorState, CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap)
			applyNetworkData(bootstrapData.currentBlockNumber, bootstrapData.rpcConnectionStatus, CONFIRM_TRANSACTION_DATA_PRIORITY.bootstrap)
		}
		void hydratePendingTransactionsFromStorage().then((pendingTransactions) => {
			if (cancelled) return
			applyPendingTransactions(pendingTransactions, CONFIRM_TRANSACTION_DATA_PRIORITY.storage)
		})
		// Sends the single startup popup_readyAndListening request and retries only while no pending request has loaded.
		void bootstrapConfirmTransactionDialog(() => cancelled || currentPendingTransactionOrSignableMessage.value !== undefined, applyBootstrapData)
		return () => {
			cancelled = true
		}
	}, [applyPendingTransactions, applySimulationState, applyNetworkData])

	return {
		currentPendingTransactionOrSignableMessage,
		pendingTransactionsAndSignableMessages,
		completeVisualizedSimulation,
		currentBlockNumber,
		rpcConnectionStatus,
		pendingTransactionAddedNotification,
		unexpectedError,
		rpcEntries,
	}
}

type ConfirmTransactionDialogData = ReturnType<typeof useConfirmTransactionDialogData>

// The failure a rejected transaction would have hit, so the website learns why it was rejected.
function getSimulationFailureMessage(pending: PendingTransactionOrSignableMessage) {
	if (pending.transactionOrMessageCreationStatus === 'FailedToSimulate') return pending.transactionToSimulate.error.message
	const simulatedTransaction = findSimulatedTransactionForPendingEntry(pending)
	if (simulatedTransaction === undefined || simulatedTransaction.transactionStatus === 'Transaction Succeeded') return undefined
	return simulatedTransaction.error.message
}

// Accept, reject and add-unsigned-to-Safe-stack actions for the request currently shown, with their button states.
function useConfirmTransactionActions({ currentPendingTransactionOrSignableMessage, pendingTransactionsAndSignableMessages, pendingTransactionAddedNotification, unexpectedError }: ConfirmTransactionDialogData) {
	const { value: rejectButtonState, waitFor: waitForRejectTransaction, reset: resetRejectButton } = useAsyncState<void>()
	const { value: approveButtonState, waitFor: waitForApproveTransaction, reset: resetApproveButton } = useAsyncState<void>()
	const { value: addToSafeStackButtonState, waitFor: waitForAddToSafeStack, reset: resetAddToSafeStackButton } = useAsyncState<void>()

	const sendConfirmDialogMessageAndShowDeliveryError = async (message: TransactionConfirmation) => {
		const deliveryError = await sendConfirmDialogMessage(message)
		if (deliveryError !== undefined) unexpectedError.value = deliveryError
	}

	async function approveTransaction() {
		const pending = currentPendingTransactionOrSignableMessage.value
		if (pending === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		await sendConfirmDialogMessageAndShowDeliveryError({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: pending.uniqueRequestIdentifier, action: 'accept' } })
	}

	async function rejectTransaction() {
		const pending = currentPendingTransactionOrSignableMessage.value
		if (pending === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		if (pendingTransactionsAndSignableMessages.value.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: pending.uniqueRequestIdentifier.requestSocket.tabId })
		await sendConfirmDialogMessageAndShowDeliveryError({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
			action: 'reject',
			errorString: getSimulationFailureMessage(pending),
		} })
	}

	const reject = () => {
		resetRejectButton()
		waitForRejectTransaction(rejectTransaction)
	}
	const approve = () => {
		resetApproveButton()
		waitForApproveTransaction(approveTransaction)
	}
	const addToSafeStack = () => {
		const pending = currentPendingTransactionOrSignableMessage.value
		if (pending === undefined) return
		resetAddToSafeStackButton()
		void waitForAddToSafeStack(async () => {
			await sendConfirmDialogMessageAndShowDeliveryError({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: pending.uniqueRequestIdentifier, action: 'addToSafeStack' } })
		})
	}

	return { reject, rejectButtonState, approve, approveButtonState, addToSafeStack, addToSafeStackButtonState }
}

function getLoadingText(current: PendingTransactionOrSignableMessage | undefined) {
	if (current === undefined) return 'Initializing...'
	if (current.transactionOrMessageCreationStatus === 'Crafting') return 'Crafting Transaction...'
	if (current.transactionOrMessageCreationStatus === 'Simulating') return 'Simulating Transaction...'
	if ('popupVisualisation' in current && current.popupVisualisation?.statusCode === 'failed') return 'Failed to simulate. Retrying...'
	return 'Loading...'
}

function ConfirmTransactionNotifications({ currentPendingTransaction, safeTransactionFlow, pendingTransactionAddedNotification, dismissedRawTransactionNotification, numberOfPendingTransactions }: {
	currentPendingTransaction: PendingTransactionOrSignableMessage
	safeTransactionFlow: ReturnType<typeof getSafeTransactionPendingFlow>
	pendingTransactionAddedNotification: Signal<boolean>
	dismissedRawTransactionNotification: Signal<bigint | undefined>
	numberOfPendingTransactions: number
}) {
	const rawTransactionToShowNotificationFor = currentPendingTransaction.type === 'Transaction'
		&& currentPendingTransaction.originalRequestParameters.method === 'eth_sendRawTransaction'
		&& currentPendingTransaction.transactionIdentifier !== dismissedRawTransactionNotification.value
		? currentPendingTransaction
		: undefined
	const getRawTransactionTargetNetworkName = (rawTransaction: PendingTransaction) => {
		if (rawTransaction.transactionOrMessageCreationStatus !== 'Simulated' || rawTransaction.popupVisualisation.statusCode === 'failed') return 'network'
		return rawTransaction.popupVisualisation.data.simulationState.rpcNetwork.name
	}
	return <>
		{ rawTransactionToShowNotificationFor === undefined
			? <></>
			: <DinoSaysNotification
				text = { `This transaction is signed already. No extra signing required to forward it to ${ getRawTransactionTargetNetworkName(rawTransactionToShowNotificationFor) }.` }
				close = { () => { dismissedRawTransactionNotification.value = rawTransactionToShowNotificationFor.transactionIdentifier } }
			/>
		}
		{ safeTransactionFlow?.kind === 'proposal'
			? <>
				<SafeProposalDetails safeTx = { safeTransactionFlow.pending.safeTransaction.safeTx } messageReview = { safeTransactionFlow.pending.safeTransaction.messageReview } />
				{ /* No close control: this notice explains what the Sign & add and Add unsigned buttons do. */ }
				<DinoSaysNotification
					text = { `This transaction will be wrapped as Gnosis Safe transaction nonce ${ safeTransactionFlow.pending.safeTransaction.safeTx.message.nonce.toString() }. Both choices add it to the local optimistic Gnosis Safe stack: Sign & add includes the signature from the owner selected in your wallet, while Add unsigned stores it without a signature. It will not be broadcast automatically.` }
					narrowSummary = { `Gnosis Safe transaction nonce ${ safeTransactionFlow.pending.safeTransaction.safeTx.message.nonce.toString() }` }
				/>
			</>
			: <></>
		}
		{ pendingTransactionAddedNotification.value === true
			? <DinoSaysNotification
				text = { `Hey! A new transaction request was queued. Accept or Reject the previous transaction${ numberOfPendingTransactions > 1 ? 's' : '' } to see the new one.` }
				close = { () => { pendingTransactionAddedNotification.value = false }}
			/>
			: <></>
		}
	</>
}

export function ConfirmTransaction() {
	const dialogData = useConfirmTransactionDialogData()
	const { currentPendingTransactionOrSignableMessage, pendingTransactionsAndSignableMessages, completeVisualizedSimulation, currentBlockNumber, rpcConnectionStatus, pendingTransactionAddedNotification, unexpectedError, rpcEntries } = dialogData
	const { reject, rejectButtonState, approve, approveButtonState, addToSafeStack, addToSafeStackButtonState } = useConfirmTransactionActions(dialogData)
	const forceSend = useSignal<boolean>(false)
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const dismissedRawTransactionNotification = useSignal<bigint | undefined>(undefined)
	const currentSafeTransactionFlow = useComputed(() => {
		const pending = currentPendingTransactionOrSignableMessage.value
		return pending?.type === 'Transaction' ? getSafeTransactionPendingFlow(pending) : undefined
	})

	const isConfirmDisabled = useComputed(() => {
		const current = currentPendingTransactionOrSignableMessage.value
		if (current === undefined) return true
		if (current.transactionOrMessageCreationStatus !== 'Simulated') return true
		if (shouldDisableConfirmForApprovalStatus(current.approvalStatus)) return true
		if (current.type !== 'Transaction') {
			return shouldDisableSignableMessageConfirm({
				isValidMessage: current.visualizedPersonalSignRequest.isValidMessage === true,
				canSignMessage: isPossibleToSignMessage(current.visualizedPersonalSignRequest, current.activeAddress),
				forceSendEnabled: forceSend.value,
				hasSupportedRpc: current.visualizedPersonalSignRequest.rpcNetwork.httpsRpc !== undefined,
			})
		}
		if (forceSend.value) return false
		const simulatedTransaction = findSimulatedTransactionForPendingEntry(current)
		return simulatedTransaction === undefined || simulatedTransaction.transactionStatus !== 'Transaction Succeeded' || simulatedTransaction.quarantine
	})
	const isAddToSafeStackDisabled = useComputed(() => {
		const pending = currentPendingTransactionOrSignableMessage.value
		if (pending?.type !== 'Transaction' || getSafeTransactionPendingFlow(pending)?.kind !== 'proposal') return true
		if (pending.approvalStatus.status === 'WaitingForSigner') return true
		const simulatedTransaction = findSimulatedTransactionForPendingEntry(pending)
		return simulatedTransaction === undefined || simulatedTransaction.transactionStatus !== 'Transaction Succeeded' || simulatedTransaction.quarantine
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

	const loadingText = useComputed(() => getLoadingText(currentPendingTransactionOrSignableMessage.value))

	async function clearUnexpectedError() {
		unexpectedError.value = undefined
		await sendPopupMessageToBackgroundPage( { method: 'popup_clearUnexpectedError' } )
	}

	const underTransactions = useComputed(() => pendingTransactionsAndSignableMessages.value.slice(1).reverse())
	const current = currentPendingTransactionOrSignableMessage.value
	const isCurrentRequestReadyToReview = current !== undefined && (current.transactionOrMessageCreationStatus === 'Simulated' || current.transactionOrMessageCreationStatus === 'FailedToSimulate')

	return (
		<main>
			<Hint>
				<ConfirmTransactionModal modalState = { modalState } activeAddress = { current?.activeAddress } rpcEntries = { rpcEntries }/>
				<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
					<div style = 'position: sticky; top: 0; z-index: 1;'>
						<ConfirmTransactionAlerts unexpectedError = { unexpectedError.value } clearUnexpectedError = { clearUnexpectedError } rpcConnectionStatus = { rpcConnectionStatus } currentPendingTransaction = { currentPendingTransactionOrSignableMessage }/>
					</div>
					{ !isCurrentRequestReadyToReview ? <CenterToPageTextSpinner text = { loadingText }/> : <div class = 'popup-contents'>
						<div style = 'margin: 10px'>
							<ConfirmTransactionNotifications
								currentPendingTransaction = { current }
								safeTransactionFlow = { currentSafeTransactionFlow.value }
								pendingTransactionAddedNotification = { pendingTransactionAddedNotification }
								dismissedRawTransactionNotification = { dismissedRawTransactionNotification }
								numberOfPendingTransactions = { pendingTransactionsAndSignableMessages.value.length }
							/>
							<div style = 'margin-bottom: 10px;'>
								<TransactionNames completeVisualizedSimulation = { completeVisualizedSimulation } currentPendingTransaction = { currentPendingTransactionOrSignableMessage } includeCurrentTransaction = { true }/>
							</div>
							<UnderTransactions pendingTransactionsAndSignableMessages = { underTransactions }/>
							<div style = { `top: ${ underTransactions.value.length * -HALF_HEADER_HEIGHT }px` }></div>
							{ current.type === 'Transaction' ?
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
									visualizedPersonalSignRequest = { current.visualizedPersonalSignRequest }
									renameAddressCallBack = { renameAddressCallBack }
									removeTransactionOrSignedMessage = { undefined }
									numberOfUnderTransactions = { underTransactions.value.length }
									editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
								/>
							</> }
						</div>
						<nav class = 'window-footer popup-button-row' style = 'position: sticky; bottom: 0; width: 100%;'>
							<CheckBoxes currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage } forceSend = { forceSend } addressBookEntries = { completeVisualizedSimulation.value.addressBookEntries } />
							<ConfirmationButtons
								currentPendingTransactionOrSignableMessage = { current }
								reject = { reject }
								rejectButtonState = { rejectButtonState.value.state }
								approve = { approve }
								approveButtonState = { approveButtonState.value.state }
								confirmDisabled = { isConfirmDisabled.value }
								addToSafeStack = { currentSafeTransactionFlow.value?.kind === 'proposal' ? addToSafeStack : undefined }
								addToSafeStackButtonState = { addToSafeStackButtonState.value.state }
								addToSafeStackDisabled = { isAddToSafeStackDisabled.value }
							/>
						</nav>
					</div> }
				</div>
			</Hint>
		</main>
	)
}
