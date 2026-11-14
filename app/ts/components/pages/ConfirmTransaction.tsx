import { SafeProposalDetails, SafeProposalSigningRequestCard } from './SafeProposalDetails.js'
import type { JSX } from 'preact'
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
import { QuarantineReasons, SafeExecutionSimulationNotice, SenderReceiver, TransactionImportanceBlock } from '../simulationExplaining/Transactions.js'
import { identifyTransaction } from '../simulationExplaining/identifyTransaction.js'
import { DinoSaysNotification } from '../subcomponents/DinoSays.js'
import { addressEditEntry, tryFocusingTabOrWindow } from '../ui-utils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { getTransactionBatchWebsite, type PopupPendingTransactionOrSignableMessage as PendingTransactionOrSignableMessage, type SimulatedPendingTransaction } from '../../types/accessRequest.js'
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
import { bigintToDecimalString, dataStringWith0xStart } from '../../utils/bigint.js'
import { browserStorageLocalGet2 } from '../../utils/storageUtils.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { type AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton, AsyncStatusIcon } from '../subcomponents/AsyncAction.js'
import type { SignerName } from '../../types/signerTypes.js'
import { assertNever } from '../../utils/typescript.js'
import { getSafeTransactionPendingFlow } from '../../safe/safePendingFlow.js'
import { getSimulatedTransactionBatch, getTransactionBatchApprovalBlocker, getTransactionBatchErrorMessage, getTransactionBatchTitle, TransactionBatchCard } from './ConfirmTransactionBatch.js'

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

type PendingConfirmationOfKind<Kind extends PendingTransactionOrSignableMessage['type']> = Extract<PendingTransactionOrSignableMessage, { readonly type: Kind }>

// How the confirmation window shows, labels and gates one kind of confirmation. getConfirmationKindView picks it with an exhaustive switch, so a new kind of confirmation does not compile until it has one. Callers narrow only by creation status, so each member checks the status it needs itself.
type ConfirmationKindView = {
	// Keys the confirmation's card in the queue shown under the current confirmation.
	readonly stackItemKey: string
	readonly website: Website
	readonly activeAddress: bigint | undefined
	// The header text of a queued confirmation whose simulation failed.
	readonly getFailedToSimulateTitle: () => string
	// The header card of a queued confirmation that was simulated.
	readonly renderSimulatedUnderCard: (style: string, absoluteStyle: string) => JSX.Element
	// The title of the current confirmation once it was simulated.
	readonly getSimulatedTitle: () => string
	// What the approval buttons name and whom they sign with, or undefined to show only the reject button.
	readonly getButtonLabels: () => { readonly identified: ConfirmationActionButtonsParams['identified'], readonly signerName: SignerName } | undefined
	// The error passed to the website when the user rejects.
	readonly getRejectionErrorString: () => string | undefined
	// Whether approving is disabled once the checks shared by every kind passed.
	readonly isConfirmDisabled: (forceSend: boolean) => boolean
	// The address book entries that a signer error's details may name.
	readonly getSignerErrorAddressBookEntries: () => readonly AddressBookEntry[]
	// The checkbox that allows approving a confirmation the Interceptor recommends against.
	readonly renderForceSendCheckBox: (forceSend: Signal<boolean>, margins: string) => JSX.Element
	// The address book entries of the shown preview, or undefined to use those of the simulation stack.
	readonly getPreviewAddressBookEntries: () => readonly AddressBookEntry[] | undefined
	// The preview run that an approval names, so the background can refuse it once that preview was replaced.
	readonly getApprovedConfirmationRunId: () => number | undefined
	readonly renderCard: (params: TransactionCardParams) => JSX.Element
}

const forceSendCheckBox = (text: string, forceSend: Signal<boolean>, margins: string) => <div style = 'display: grid'>
	<div style = { margins }>
		<ErrorCheckBox text = { text } checked = { forceSend } />
	</div>
</div>

function getTransactionView(pending: PendingConfirmationOfKind<'Transaction'>): ConfirmationKindView {
	const getSimulatedResults = () => {
		if (pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success' || pending.popupVisualisation.data.visualizedSimulationState.success === false) return undefined
		return getResultsForTransaction(pending.popupVisualisation.data.visualizedSimulationState, pending.transactionIdentifier)
	}
	return {
		stackItemKey: `transaction-${ pending.transactionIdentifier.toString() }`,
		website: pending.website,
		activeAddress: pending.activeAddress,
		getFailedToSimulateTitle: () => pending.transactionOrMessageCreationStatus === 'FailedToSimulate' ? pending.transactionToSimulate.error.message : getTransactionStatusLabel(pending.transactionOrMessageCreationStatus),
		renderSimulatedUnderCard: (style, absoluteStyle) => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return <></>
			if (pending.popupVisualisation.statusCode === 'success' && pending.popupVisualisation.data.visualizedSimulationState.success) {
				const simTx = getResultsForTransaction(pending.popupVisualisation.data.visualizedSimulationState, pending.transactionIdentifier)
				if (simTx === undefined) throw new Error('No simulated and visualized transactions')
				return <div key = { `transaction-${ pending.transactionIdentifier.toString() }` } class = 'card' style = { style }>
					<TransactionHeader simTx = { simTx } />
					<div style = { absoluteStyle }></div>
				</div>
			}
			return <div key = { `transaction-${ pending.transactionIdentifier.toString() }` } class = 'card' style = { style }>
				<TransactionHeaderForFailedToSimulate website = { pending.transactionToSimulate.website } />
				<div style = { absoluteStyle }></div>
			</div>
		},
		getSimulatedTitle: () => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return getTransactionStatusLabel(pending.transactionOrMessageCreationStatus)
			if (pending.popupVisualisation.statusCode === 'failed') return 'Failing transaction'
			const lastTx = getSimulatedResults()
			if (lastTx === undefined) return 'Could not find transaction...'
			return identifyTransaction(lastTx).title
		},
		getButtonLabels: () => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return undefined
			const lastTx = getSimulatedResults()
			if (lastTx === undefined) return undefined
			return { identified: identifyTransaction(lastTx), signerName: pending.popupVisualisation.data.signerName }
		},
		getRejectionErrorString: () => {
			if (pending.transactionOrMessageCreationStatus === 'FailedToSimulate') return pending.transactionToSimulate.error.message
			const results = getSimulatedResults()
			if (results === undefined) return undefined
			return results.transactionStatus !== 'Transaction Succeeded' ? results.error.message : undefined
		},
		isConfirmDisabled: (forceSend) => {
			if (forceSend) return false
			const lastTx = getSimulatedResults()
			if (lastTx === undefined) return true
			if (lastTx.transactionStatus !== 'Transaction Succeeded') return true
			if (lastTx.quarantine) return true
			return false
		},
		getSignerErrorAddressBookEntries: () => [],
		renderForceSendCheckBox: (forceSend, margins) => {
			const currentResults = getSimulatedResults()
			if (currentResults === undefined) return <></>
			if (currentResults.transactionStatus !== 'Transaction Succeeded') return forceSendCheckBox('I understand that the transaction will fail but I want to send it anyway.', forceSend, margins)
			if (currentResults.quarantine === true) return forceSendCheckBox('I understand that there are issues with this transaction but I want to send it anyway against Interceptors recommendations.', forceSend, margins)
			return <></>
		},
		getPreviewAddressBookEntries: () => pending.transactionOrMessageCreationStatus === 'Simulated' && pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.addressBookEntries : undefined,
		getApprovedConfirmationRunId: () => undefined,
		renderCard: (params) => <TransactionCard { ...params } />,
	}
}

function getSignableMessageView(pending: PendingConfirmationOfKind<'SignableMessage'>): ConfirmationKindView {
	return {
		stackItemKey: `message-${ pending.uniqueRequestIdentifier.requestId.toString() }`,
		website: pending.website,
		activeAddress: pending.activeAddress,
		// A message is never left FailedToSimulate, so only its status is shown.
		getFailedToSimulateTitle: () => getTransactionStatusLabel(pending.transactionOrMessageCreationStatus),
		renderSimulatedUnderCard: (style, absoluteStyle) => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return <></>
			return <div key = { `message-${ pending.uniqueRequestIdentifier.requestId.toString() }` } class = 'card' style = { style }>
				<SignatureHeader visualizedPersonalSignRequest = { pending.visualizedPersonalSignRequest }/>
				<div style = { absoluteStyle }></div>
			</div>
		},
		getSimulatedTitle: () => pending.transactionOrMessageCreationStatus === 'Simulated' ? identifySignature(pending.visualizedPersonalSignRequest).title : getTransactionStatusLabel(pending.transactionOrMessageCreationStatus),
		getButtonLabels: () => pending.transactionOrMessageCreationStatus === 'Simulated' ? { identified: identifySignature(pending.visualizedPersonalSignRequest), signerName: pending.visualizedPersonalSignRequest.signerName } : undefined,
		getRejectionErrorString: () => undefined,
		isConfirmDisabled: (forceSend) => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return true
			return shouldDisableSignableMessageConfirm({
				isValidMessage: pending.visualizedPersonalSignRequest.isValidMessage === true,
				canSignMessage: isPossibleToSignMessage(pending.visualizedPersonalSignRequest, pending.activeAddress),
				forceSendEnabled: forceSend,
				hasSupportedRpc: pending.visualizedPersonalSignRequest.rpcNetwork.httpsRpc !== undefined,
			})
		},
		getSignerErrorAddressBookEntries: () => pending.transactionOrMessageCreationStatus !== 'Simulated' ? [] : [
			pending.visualizedPersonalSignRequest.account,
			pending.visualizedPersonalSignRequest.activeAddress,
			...(pending.visualizedPersonalSignRequest.type === 'SafeTx' ? [pending.visualizedPersonalSignRequest.verifyingContract, ...pending.visualizedPersonalSignRequest.parsedMessageDataAddressBookEntries] : []),
		],
		renderForceSendCheckBox: (forceSend) => {
			if (pending.transactionOrMessageCreationStatus !== 'Simulated') return <></>
			const visualizedPersonalSignRequest = pending.visualizedPersonalSignRequest
			return  <>
				{ isPossibleToSignMessage(visualizedPersonalSignRequest, visualizedPersonalSignRequest.activeAddress.address) && visualizedPersonalSignRequest.quarantine
					? <div style = 'display: grid'>
						<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
							<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } />
						</div>
					</div>
					: <></>
				}
			</>
		},
		getPreviewAddressBookEntries: () => undefined,
		getApprovedConfirmationRunId: () => undefined,
		renderCard: (params) => pending.transactionOrMessageCreationStatus !== 'Simulated' ? <></> : <>
			<SignatureCard
				visualizedPersonalSignRequest = { pending.visualizedPersonalSignRequest }
				renameAddressCallBack = { params.renameAddressCallBack }
				removeTransactionOrSignedMessage = { undefined }
				numberOfUnderTransactions = { params.numberOfUnderTransactions }
				editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }
			/>
		</>,
	}
}

function getTransactionBatchView(pending: PendingConfirmationOfKind<'TransactionBatch'>): ConfirmationKindView {
	const simulatedBatch = getSimulatedTransactionBatch(pending)
	return {
		stackItemKey: `batch-${ pending.uniqueRequestIdentifier.requestId.toString() }`,
		website: getTransactionBatchWebsite(pending),
		activeAddress: pending.binding.account,
		getFailedToSimulateTitle: () => (simulatedBatch === undefined ? undefined : getTransactionBatchErrorMessage(simulatedBatch)) ?? 'Simulation failed',
		renderSimulatedUnderCard: (style, absoluteStyle) => <div key = { `batch-${ pending.uniqueRequestIdentifier.requestId.toString() }` } class = 'card' style = { style }>
			<header class = 'card-header'>
				<p class = 'card-header-title' style = 'white-space: nowrap;'>{ getTransactionBatchTitle(pending) }</p>
				<WebsiteOriginText website = { getTransactionBatchWebsite(pending) } class = 'card-header-website' />
			</header>
			<div style = { absoluteStyle }></div>
		</div>,
		getSimulatedTitle: () => getTransactionBatchTitle(pending),
		getButtonLabels: () => simulatedBatch === undefined ? undefined : { identified: { title: getTransactionBatchTitle(pending), signingAction: 'Send batch', simulationAction: 'Simulate batch', rejectAction: 'Reject batch' }, signerName: simulatedBatch.popupVisualisation.data.signerName },
		getRejectionErrorString: () => simulatedBatch === undefined ? undefined : getTransactionBatchErrorMessage(simulatedBatch),
		isConfirmDisabled: (forceSend) => {
			if (simulatedBatch === undefined) return true
			const approvalBlocker = getTransactionBatchApprovalBlocker(simulatedBatch)
			return approvalBlocker === 'notSimulated' || (approvalBlocker === 'requiresForceSend' && !forceSend)
		},
		getSignerErrorAddressBookEntries: () => [],
		renderForceSendCheckBox: (forceSend, margins) => {
			if (simulatedBatch === undefined || getTransactionBatchApprovalBlocker(simulatedBatch) !== 'requiresForceSend') return <></>
			return forceSendCheckBox('I understand that some calls in this batch fail or have issues, but I want to send the whole batch anyway against Interceptors recommendations.', forceSend, margins)
		},
		getPreviewAddressBookEntries: () => simulatedBatch?.popupVisualisation.statusCode === 'success' ? simulatedBatch.popupVisualisation.data.addressBookEntries : undefined,
		getApprovedConfirmationRunId: () => simulatedBatch?.popupVisualisation.data.confirmationRunId,
		renderCard: (params) => <div style = { `position: relative; top: ${ params.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
			<TransactionBatchCard
				currentPendingTransaction = { params.currentPendingTransaction }
				renameAddressCallBack = { params.renameAddressCallBack }
				editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }
				currentBlockNumber = { params.currentBlockNumber }
				rpcConnectionStatus = { params.rpcConnectionStatus }
			/>
		</div>,
	}
}

export function getConfirmationKindView(pending: PendingTransactionOrSignableMessage): ConfirmationKindView {
	switch (pending.type) {
		case 'Transaction': return getTransactionView(pending)
		case 'SignableMessage': return getSignableMessageView(pending)
		case 'TransactionBatch': return getTransactionBatchView(pending)
		default: return assertNever(pending)
	}
}

function UnderTransactions(param: UnderTransactionsParams) {
	const absoluteStyle = 'background-color: var(--disabled-card-color); position: absolute; width: 100%; height: 100%; top: 0px'
	const nTx = param.pendingTransactionsAndSignableMessages.value.length
	return <div style = { `position: relative; top: ${ nTx * -HALF_HEADER_HEIGHT }px;` }>
		{ param.pendingTransactionsAndSignableMessages.value.map((pendingTransaction, index) => {
			const style = `margin-bottom: 0px; scale: ${ Math.pow(0.95, nTx - index) }; position: relative; top: ${ (nTx - index) * HALF_HEADER_HEIGHT }px;`
			const view = getConfirmationKindView(pendingTransaction)
			if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return <div key = { view.stackItemKey } class = 'card' style = { style }>
				<header class = 'card-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? <img src = '../img/error-icon.svg' width = '24' height = '24'/> : <Spinner height = '2em'/> }
						</span>
					</div>
					<p class = 'card-header-title' style = 'white-space: nowrap;'>
						{ pendingTransaction.transactionOrMessageCreationStatus === 'FailedToSimulate' ? view.getFailedToSimulateTitle() : 'Simulating...' }
					</p>
					<WebsiteOriginText website = { view.website } class = 'card-header-website' />
				</header>
				<div style = { absoluteStyle }></div>
			</div>
			return view.renderSimulatedUnderCard(style, absoluteStyle)
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

const TransactionNames = (param: TransactionNamesParams) => {
	const titleOfCurrentPendingTransaction = () => {
		const currentPendingTransactionOrSignableMessage = param.currentPendingTransaction.value
		if (currentPendingTransactionOrSignableMessage === undefined) return 'Loading...'
		if (currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return getTransactionStatusLabel(currentPendingTransactionOrSignableMessage.transactionOrMessageCreationStatus)
		return getConfirmationKindView(currentPendingTransactionOrSignableMessage).getSimulatedTitle()
	}

	const namesWithCurrentTransaction = useComputed(() => {
		if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough' || param.completeVisualizedSimulation.value.visualizedSimulationState.success === false) return []
		const visualizedBlocks = param.completeVisualizedSimulation.value.visualizedSimulationState.visualizedBlocks
		const transactionsAndMessages = visualizedBlocks.flatMap((block) => [...block.visualizedPersonalSignRequests, ...block.simulatedAndVisualizedTransactions])
		const names = transactionsAndMessages.map((transactionOrMessage) => 'transaction' in transactionOrMessage ? identifyTransaction(transactionOrMessage).title : identifySignature(transactionOrMessage).title)
		return [...param.completeVisualizedSimulation.value.numberOfAddressesMadeRich > 0 ? [`Simply making ${ param.completeVisualizedSimulation.value.numberOfAddressesMadeRich } addresses rich`] : [], ...names, ...param.includeCurrentTransaction ? [titleOfCurrentPendingTransaction()] : [] ]
	})

	if (param.completeVisualizedSimulation.value.simulationResultState !== 'done' || param.completeVisualizedSimulation.value.simulationState.kind === 'passthrough') return <></>

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

				<SafeExecutionSimulationNotice simulationOptions = { simTx.simulationOptions }/>

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

				<div class = 'transaction-card-footer'>
					{ simTx.transactionStatus === 'Failed To Simulate' ? <></> :
						<div class = 'log-cell'>
							<span class = 'log-table' style = { { display: 'inline-flex' } }>
								<GasFee tx = { simTx } rpcNetwork = { rpcNetwork } />
							</span>
						</div>
					}
					<div class = 'log-cell'>
						<TransactionCreated created = { currentPendingTransaction.created } />
					</div>
					<div class = 'log-cell'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { simulationBlockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { popupVisualisation.data.simulationState.simulationConductedTimestamp }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					</div>
				</div>
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
	const view = getConfirmationKindView(current)
	const addressBookEntries = [...view.getSignerErrorAddressBookEntries(), ...(params.addressBookEntries ?? [])]
	if (current.approvalStatus.status === 'SignerError') return <div style = 'display: grid'>
		<div style = { margins }>
			<ErrorComponent text = { current.approvalStatus.message } />
			{ current.approvalStatus.safeSignerErrorDetails === undefined
				? <></>
				: <SafeSignerErrorDetails details = { current.approvalStatus.safeSignerErrorDetails } addressBookEntries = { addressBookEntries } />
			}
		</div>
	</div>
	return view.renderForceSendCheckBox(params.forceSend, margins)
}

type NetworkErrorParams = {
	currentPendingTransactionOrSignableMessage: ReadonlySignal<PendingTransactionOrSignableMessage | undefined>
}

const WebsiteErrors = ({ currentPendingTransactionOrSignableMessage }: NetworkErrorParams) => {
	const current = currentPendingTransactionOrSignableMessage.value
	if (current === undefined) return <></>
	const message = getWebsiteWarningMessage(getConfirmationKindView(current).website.websiteOrigin, current.simulationMode)
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

	const buttonLabels = getConfirmationKindView(currentPendingTransactionOrSignableMessage).getButtonLabels()
	if (buttonLabels === undefined) return <RejectButton onClick = { reject } state = { rejectButtonState }/>
	const { identified, signerName } = buttonLabels

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

export function ConfirmTransaction() {
	const currentPendingTransactionOrSignableMessage = useSignal<PendingTransactionOrSignableMessage | undefined>(undefined)
	const currentSafeTransactionFlow = useComputed(() => {
		const pending = currentPendingTransactionOrSignableMessage.value
		return pending?.type === 'Transaction' ? getSafeTransactionPendingFlow(pending) : undefined
	})
	const pendingTransactionsAndSignableMessages = useSignal<readonly PendingTransactionOrSignableMessage[]>([])
	const completeVisualizedSimulation = useSignal<CompleteVisualizedSimulation>(createPassthroughCompleteVisualizedSimulation())
	const forceSend = useSignal<boolean>(false)
	const currentBlockNumber = useSignal<undefined | bigint>(undefined)
	const modalState = useSignal<ModalState>({ page: 'noModal' })
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const pendingTransactionAddedNotification = useSignal<boolean>(false)
	const dismissedRawTransactionNotification = useSignal<bigint | undefined>(undefined)
	const unexpectedError = useSignal<CaughtError | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>([])
	const pendingTransactionsDataPriority = useSignal(0)
	const simulationDataPriority = useSignal(0)
	const networkDataPriority = useSignal(0)

	const applyPendingTransactions = (pendingTransactions: readonly PendingTransactionOrSignableMessage[], priority: number) => {
		if (priority < pendingTransactionsDataPriority.value) return
		pendingTransactionsDataPriority.value = priority
		const previousPendingTransactions = pendingTransactionsAndSignableMessages.value
		pendingTransactionsAndSignableMessages.value = pendingTransactions
		if (previousPendingTransactions.length > 0 && pendingTransactions.length > previousPendingTransactions.length) pendingTransactionAddedNotification.value = true
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
			if (parsed.method === 'popup_rpc_connection_status_changed') {
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
		return noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
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

	async function approveTransaction() {
		if (currentPendingTransactionOrSignableMessage.value === undefined) throw new Error('dialogState is not set')
		// A batch approval names the preview shown when the user clicked, so the background can refuse it if that preview was replaced in the meantime.
		const approvedConfirmationRunId = getConfirmationKindView(currentPendingTransactionOrSignableMessage.value).getApprovedConfirmationRunId()
		pendingTransactionAddedNotification.value = false
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		const deliveryError = await sendConfirmDialogMessage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier, action: 'accept', ...(approvedConfirmationRunId === undefined ? {} : { approvedConfirmationRunId }) } })
		if (deliveryError !== undefined) unexpectedError.value = deliveryError
	}
	async function rejectTransaction() {
		if (currentPendingTransactionOrSignableMessage.value === undefined) throw new Error('dialogState is not set')
		pendingTransactionAddedNotification.value = false
		const currentWindow = await browser.windows.getCurrent()
		checkAndThrowRuntimeLastError()
		if (currentWindow.id === undefined) throw new Error('could not get our own Id!')
		if (pendingTransactionsAndSignableMessages.value.length === 1) await tryFocusingTabOrWindow({ type: 'tab', id: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier.requestSocket.tabId })

		const getPossibleErrorString = () => {
			const pending = currentPendingTransactionOrSignableMessage.value
			if (pending === undefined) return undefined
			return getConfirmationKindView(pending).getRejectionErrorString()
		}

		const deliveryError = await sendConfirmDialogMessage({ method: 'popup_confirmDialog', data: {
			uniqueRequestIdentifier: currentPendingTransactionOrSignableMessage.value.uniqueRequestIdentifier,
			action: 'reject',
			errorString: getPossibleErrorString(),
		} })
		if (deliveryError !== undefined) unexpectedError.value = deliveryError
	}
	const { value: rejectButtonState, waitFor: waitForRejectTransaction, reset: resetRejectButton } = useAsyncState<void>()
	const { value: approveButtonState, waitFor: waitForApproveTransaction, reset: resetApproveButton } = useAsyncState<void>()
	const { value: addToSafeStackButtonState, waitFor: waitForAddToSafeStack, reset: resetAddToSafeStackButton } = useAsyncState<void>()
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
			const deliveryError = await sendConfirmDialogMessage({ method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: pending.uniqueRequestIdentifier, action: 'addToSafeStack' } })
			if (deliveryError !== undefined) unexpectedError.value = deliveryError
		})
	}
	const dismissRawTransactionNotification = () => {
		const current = currentPendingTransactionOrSignableMessage.value
		if (current?.type !== 'Transaction') return
		dismissedRawTransactionNotification.value = current.transactionIdentifier
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
		if (shouldDisableConfirmForApprovalStatus(currentPendingTransactionOrSignableMessage.value.approvalStatus)) return true
		return getConfirmationKindView(currentPendingTransactionOrSignableMessage.value).isConfirmDisabled(forceSend.value)
	})
	const isAddToSafeStackDisabled = useComputed(() => {
		const pending = currentPendingTransactionOrSignableMessage.value
		if (pending?.type !== 'Transaction' || getSafeTransactionPendingFlow(pending)?.kind !== 'proposal') return true
		if (pending.approvalStatus.status === 'WaitingForSigner') return true
		if (pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') return true
		if (pending.popupVisualisation.data.visualizedSimulationState.success === false) return true
		const lastTx = getResultsForTransaction(pending.popupVisualisation.data.visualizedSimulationState, pending.transactionIdentifier)
		return lastTx === undefined || lastTx.transactionStatus !== 'Transaction Succeeded' || lastTx.quarantine
	})

	function getCurrentAddressBookEntries() {
		const current = currentPendingTransactionOrSignableMessage.value
		return (current === undefined ? undefined : getConfirmationKindView(current).getPreviewAddressBookEntries()) ?? completeVisualizedSimulation.value.addressBookEntries
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

	const underTransactions = useComputed(() => pendingTransactionsAndSignableMessages.value.slice(1).reverse())

	if (currentPendingTransactionOrSignableMessage.value === undefined || (currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated' && currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'FailedToSimulate')) {
		return <>
				<main>
					<Hint>
						<ConfirmTransactionModal modalState = { modalState } activeAddress = { currentPendingTransactionOrSignableMessage.value === undefined ? undefined : getConfirmationKindView(currentPendingTransactionOrSignableMessage.value).activeAddress } rpcEntries = { rpcEntries }/>
						<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px;'>
							<ConfirmTransactionAlerts unexpectedError = { unexpectedError.value } clearUnexpectedError = { clearUnexpectedError } rpcConnectionStatus = { rpcConnectionStatus } currentPendingTransaction = { currentPendingTransactionOrSignableMessage }/>
								<CenterToPageTextSpinner text = { loadingText }/>
					</div>
				</Hint>
			</main>
		</>
	}
	return (
			<main>
				<Hint>
					<ConfirmTransactionModal modalState = { modalState } activeAddress = { currentPendingTransactionOrSignableMessage.value === undefined ? undefined : getConfirmationKindView(currentPendingTransactionOrSignableMessage.value).activeAddress } rpcEntries = { rpcEntries }/>
					<div class = 'block popup-block popup-block-scroll' style = 'padding: 0px'>
						<div style = 'position: sticky; top: 0; z-index: 1;'>
							<ConfirmTransactionAlerts unexpectedError = { unexpectedError.value } clearUnexpectedError = { clearUnexpectedError } rpcConnectionStatus = { rpcConnectionStatus } currentPendingTransaction = { currentPendingTransactionOrSignableMessage }/>
					</div>
					<div class = 'popup-contents'>
						<div style = 'margin: 10px'>
							{ currentPendingTransactionOrSignableMessage.value.originalRequestParameters.method === 'eth_sendRawTransaction' && currentPendingTransactionOrSignableMessage.value.type === 'Transaction' && currentPendingTransactionOrSignableMessage.value.transactionIdentifier !== dismissedRawTransactionNotification.value
								? <DinoSaysNotification
									text = { `This transaction is signed already. No extra signing required to forward it to ${ currentPendingTransactionOrSignableMessage.value.transactionOrMessageCreationStatus !== 'Simulated' || currentPendingTransactionOrSignableMessage.value.popupVisualisation.statusCode === 'failed' ?
									'network' :
									currentPendingTransactionOrSignableMessage.value.popupVisualisation.data.simulationState.rpcNetwork.name }.` }
									close = { dismissRawTransactionNotification }
								/>
								: <></>
							}
							{ currentSafeTransactionFlow.value?.kind === 'proposal' ? <SafeProposalDetails safeTx = { currentSafeTransactionFlow.value.pending.safeTransaction.safeTx } messageReview = { currentSafeTransactionFlow.value.pending.safeTransaction.messageReview } /> : <></> }
							{ currentSafeTransactionFlow.value?.kind === 'proposal'
								? <DinoSaysNotification
									text = { `This transaction will be wrapped as Gnosis Safe transaction nonce ${ currentSafeTransactionFlow.value.pending.safeTransaction.safeTx.message.nonce.toString() }. Both choices add it to the local optimistic Gnosis Safe stack: Sign & add includes the signature from the owner selected in your wallet, while Add unsigned stores it without a signature. It will not be broadcast automatically.` }
									narrowSummary = { `Gnosis Safe transaction nonce ${ currentSafeTransactionFlow.value.pending.safeTransaction.safeTx.message.nonce.toString() }` }
									close = { () => undefined }
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
							{ getConfirmationKindView(currentPendingTransactionOrSignableMessage.value).renderCard({
								currentPendingTransaction: currentPendingTransactionOrSignableMessage,
								pendingTransactionsAndSignableMessages: pendingTransactionsAndSignableMessages.value,
								renameAddressCallBack,
								editEnsNamedHashCallBack,
								currentBlockNumber,
								rpcConnectionStatus,
								numberOfUnderTransactions: underTransactions.value.length,
							}) }
						</div>
						<nav class = 'window-footer popup-button-row' style = 'position: sticky; bottom: 0; width: 100%;'>
							<CheckBoxes currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage } forceSend = { forceSend } addressBookEntries = { completeVisualizedSimulation.value.addressBookEntries } />
					<ConfirmationButtons
						currentPendingTransactionOrSignableMessage = { currentPendingTransactionOrSignableMessage.value }
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
					</div>
				</div>
			</Hint>
		</main>
	)
}
