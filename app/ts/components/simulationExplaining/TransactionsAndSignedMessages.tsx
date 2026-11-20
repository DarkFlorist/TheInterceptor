// The simulation stack list: one row per pending transaction or signed message, each with its preview or simulated card and the optional block delay picker.
import type { BlockTimeManipulationWithNoDelay, NonSimulatedAndVisualizedTransaction, ResolvedSimulationResults, SignedMessageTransaction, SimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { SmallAddress } from '../subcomponents/address.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate } from './SimulationSummary.js'
import { assertNever } from '../../utils/typescript.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { SignatureCard, SignatureHeader } from '../pages/PersonalSign.js'
import { bigintSecondsToDate, bigintToDecimalString, dataStringWith0xStart, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import type { EnrichedEthereumInputData } from '../../types/EnrichedEthereumData.js'
import { type DeltaUnit, TimePicker, type TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import type { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { useEffect } from 'preact/hooks'
import type { SignalOrValue } from '../../utils/signals.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import { normalizeSimulationStackRows, type SimulationStackMessageRow, type SimulationStackTransactionRow } from './simulationStackRows.js'
import type { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { getSimulationStackElementId } from '../../utils/simulationStackTargets.js'
import { PendingStackHeader, Transaction, type CollapsibleStackCardParams } from './Transactions.js'

function getStackRowIdentifier(stackRow: SimulationStackTransactionRow | SimulationStackMessageRow): TransactionOrMessageIdentifier {
	if (stackRow.type === 'Message') return { type: 'Message', messageIdentifier: stackRow.signedMessageTransaction.messageIdentifier }
	return { type: 'Transaction', transactionIdentifier: stackRow.preSimulationTransaction.transactionIdentifier }
}

function TransactionPreviewDetails({
	website,
	created,
	originalRequestParameters,
	signedTransaction,
	parsedInputData,
	addressMetaData,
	renameAddressCallBack,
	errorMessage,
	title,
	collapsed,
	toggleCollapsed,
}: {
	website: SignalOrValue<Website | undefined>,
	created: Date,
	originalRequestParameters: OriginalSendRequestParameters,
	signedTransaction: EthereumSendableSignedTransaction,
	parsedInputData: EnrichedEthereumInputData | undefined,
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>,
	renameAddressCallBack: RenameAddressCallBack,
	errorMessage: string | undefined,
	title: string,
} & CollapsibleStackCardParams) {
	const from = getAddressBookEntryOrAFiller(addressMetaData.value, signedTransaction.from)
	const to = signedTransaction.to === null || signedTransaction.to === undefined ? undefined : getAddressBookEntryOrAFiller(addressMetaData.value, signedTransaction.to)
	const headerActionLabel = collapsed === undefined ? undefined : collapsed ? 'Expand transaction details' : 'Collapse transaction details'
	return <div class = 'card'>
		<PendingStackHeader
			title = { title }
			website = { website }
			statusIcon = { errorMessage === undefined ? '../img/question-mark-sign.svg' : '../img/error-icon.svg' }
			onHeaderClick = { toggleCollapsed }
			openLabel = { headerActionLabel }
			ariaExpanded = { collapsed === undefined ? undefined : !collapsed }
		/>
		{ collapsed === true ? <></> : <div class = 'card-content' style = 'padding-bottom: 5px;'>
			{ errorMessage === undefined ? <></> : <ErrorComponent text = { errorMessage } containerStyle = { { margin: '0px', marginBottom: '10px' } } /> }
			<div class = 'container'>
				<dl class = 'grid key-value-pair'>
					<dt>Transaction type</dt>
					<dd>{ signedTransaction.type }</dd>
					<dt>From</dt>
					<dd><SmallAddress addressBookEntry = { from } renameAddressCallBack = { renameAddressCallBack } /></dd>
					<dt>To</dt>
					<dd>{ to === undefined ? 'No receiving Address' : <SmallAddress addressBookEntry = { to } renameAddressCallBack = { renameAddressCallBack } /> }</dd>
					<dt>Value</dt>
					<dd>{ `${ bigintToDecimalString(signedTransaction.value, 18n) } ether` }</dd>
					<dt>Nonce</dt>
					<dd>{ signedTransaction.nonce.toString(10) }</dd>
					<dt>Chain ID</dt>
					<dd>{ 'chainId' in signedTransaction && signedTransaction.chainId !== undefined ? signedTransaction.chainId.toString(10) : 'Unknown' }</dd>
				</dl>
			</div>
			<div class = 'textbox' style = 'margin-top: 10px;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Original request</p>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color); white-space: pre-wrap; word-break: break-word;'>{ stringifyJSONWithBigInts(originalRequestParameters, 2) }</p>
			</div>
			<div style = 'margin-top: 10px;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Transaction Input</p>
				{ parsedInputData === undefined
					? <div class = 'textbox'><pre>{ dataStringWith0xStart(signedTransaction.input) }</pre></div>
					: <TransactionInput parsedInputData = { parsedInputData } input = { signedTransaction.input } to = { to } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack } />
				}
			</div>
			<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<TransactionCreated created = { created } />
				</div>
				<div class = 'log-cell' style = { { display: 'inline-flex', justifyContent: 'right' } } />
			</span>
		</div> }
	</div>
}

function MessagePreviewDetails({
	website,
	created,
	signedMessageTransaction,
	visualizedPersonalSignRequest,
	errorMessage,
	collapsed,
	toggleCollapsed,
}: {
	website: SignalOrValue<Website | undefined>,
	created: Date,
	signedMessageTransaction: SignedMessageTransaction,
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest | undefined,
	errorMessage: string | undefined,
} & CollapsibleStackCardParams) {
	const headerActionLabel = collapsed === undefined ? undefined : collapsed ? 'Expand signature details' : 'Collapse signature details'
	return <div class = 'card'>
		<PendingStackHeader
			title = { errorMessage === undefined ? 'Pending signature' : 'Signature failed' }
			website = { website }
			statusIcon = { errorMessage === undefined ? '../img/question-mark-sign.svg' : '../img/error-icon.svg' }
			onHeaderClick = { toggleCollapsed }
			openLabel = { headerActionLabel }
			ariaExpanded = { collapsed === undefined ? undefined : !collapsed }
		/>
		{ collapsed === true ? <></> : <div class = 'card-content' style = 'padding-bottom: 5px;'>
			{ errorMessage === undefined ? <></> : <ErrorComponent text = { errorMessage } containerStyle = { { margin: '0px', marginBottom: '10px' } } /> }
			<div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Signature request</p>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color); white-space: pre-wrap; word-break: break-word;'>{ stringifyJSONWithBigInts(signedMessageTransaction.originalRequestParameters, 2) }</p>
			</div>
			<div class = 'textbox' style = 'margin-top: 10px;'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw request</p>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color); white-space: pre-wrap; word-break: break-word;'>{ stringifyJSONWithBigInts(signedMessageTransaction.request, 2) }</p>
			</div>
			{ visualizedPersonalSignRequest === undefined ? <></> : <div style = 'margin-top: 10px;'>
				<SignatureCard
					visualizedPersonalSignRequest = { visualizedPersonalSignRequest }
					renameAddressCallBack = { () => undefined }
					removeTransactionOrSignedMessage = { undefined }
					editEnsNamedHashCallBack = { () => undefined }
					numberOfUnderTransactions = { 0 }
				/>
			</div> }
			<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'>
					<TransactionCreated created = { created } />
				</div>
				<div class = 'log-cell' style = { { display: 'inline-flex', justifyContent: 'right' } } />
			</span>
		</div> }
	</div>
}

type TransactionOrMessageWithBlockTimeManipulatorParams = {
	simulationAndVisualisationResults: ReadonlySignal<SimulationAndVisualisationResults | undefined>
	stackRow: SimulationStackTransactionRow | SimulationStackMessageRow
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	removeTransactionOrSignedMessage?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	activeAddress: ReadonlySignal<bigint | undefined>
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
	blockTimeManipulation: BlockTimeManipulationWithNoDelay
	showTimePicker?: boolean
	displayMode?: 'full' | 'titleOnly'
	openSimulationStackAt?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	stackRowElementId?: string
	highlightStackRow?: boolean
}

function getPendingTransactionTitle(stackRow: SimulationStackTransactionRow) {
	if (stackRow.preSimulationTransaction.originalRequestParameters.method === 'eth_sendRawTransaction') return 'Pending raw transaction'
	return 'Pending transaction'
}

function TransactionOrMessageTitleOnlyCard({
	stackRow,
	removeTransactionOrSignedMessage,
	openSimulationStackAt,
}: {
	stackRow: SimulationStackTransactionRow | SimulationStackMessageRow
	removeTransactionOrSignedMessage?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	openSimulationStackAt?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
}) {
	const stackRowIdentifier = getStackRowIdentifier(stackRow)
	const openHeader = openSimulationStackAt === undefined ? undefined : () => openSimulationStackAt(stackRowIdentifier)
	if (stackRow.type === 'Message') {
		if (stackRow.status === 'simulated' && stackRow.visualizedPersonalSignRequest !== undefined) {
			return <div class = 'card'>
				<SignatureHeader
					visualizedPersonalSignRequest = { stackRow.visualizedPersonalSignRequest }
					removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
					onHeaderClick = { openHeader }
				/>
			</div>
		}
		return <div class = 'card'>
			<PendingStackHeader
				title = 'Pending signature'
				website = { stackRow.signedMessageTransaction.website }
				statusIcon = '../img/question-mark-sign.svg'
				onHeaderClick = { openHeader }
				openLabel = 'Open this signature in the full simulation stack'
			/>
		</div>
	}
	if (stackRow.status === 'simulated' && stackRow.simulatedTransaction !== undefined) {
		const simulatedTransaction = stackRow.simulatedTransaction
		const remove = removeTransactionOrSignedMessage === undefined ? undefined : () => {
			return removeTransactionOrSignedMessage({ type: 'Transaction', transactionIdentifier: simulatedTransaction.transactionIdentifier })
		}
		return <div class = 'card'>
			<TransactionHeader simTx = { simulatedTransaction } removeTransactionOrSignedMessage = { remove } onHeaderClick = { openHeader } />
		</div>
	}
	if (stackRow.status === 'failed') {
		return <div class = 'card'>
			<TransactionHeaderForFailedToSimulate website = { stackRow.preSimulationTransaction.website } onHeaderClick = { openHeader } />
		</div>
	}
	return <div class = 'card'>
		<PendingStackHeader
			title = { getPendingTransactionTitle(stackRow) }
			website = { stackRow.preSimulationTransaction.website }
			statusIcon = '../img/question-mark-sign.svg'
			onHeaderClick = { openHeader }
			openLabel = 'Open this transaction in the full simulation stack'
		/>
	</div>
}

const TransactionOrMessageWithBlockTimeManipulator = ({ stackRow, renameAddressCallBack, editEnsNamedHashCallBack, removeTransactionOrSignedMessage, simulationAndVisualisationResults, activeAddress, addressMetaData, blockTimeManipulation, showTimePicker = true, displayMode = 'full', openSimulationStackAt, stackRowElementId, highlightStackRow = false }: TransactionOrMessageWithBlockTimeManipulatorParams) => {
	const timeSelectorMode = useSignal<TimePickerMode>('No Delay')
	const timeSelectorAbsoluteTime = useSignal<Date | undefined>(undefined)
	const timeSelectorDeltaValue = useSignal<bigint>(12n)
	const timeSelectorDeltaUnit = useSignal<DeltaUnit>('Seconds')
	const collapsed = useSignal(false)
	const currentSimulationAndVisualisationResults = simulationAndVisualisationResults.value
	const toggleCollapsed = () => {
		collapsed.value = !collapsed.value
	}

	useEffect(() => {
		if (displayMode !== 'full' || !highlightStackRow) return
		collapsed.value = false
	}, [displayMode, highlightStackRow])

	// Resync the picker from the stored manipulation whenever that value changes; unrelated row updates keep the picker as the user left it.
	useEffect(() => {
		switch(blockTimeManipulation.type) {
			case 'No Delay': {
				timeSelectorMode.value = 'No Delay'
				timeSelectorAbsoluteTime.value = undefined
				timeSelectorDeltaValue.value = 12n
				timeSelectorDeltaUnit.value = 'Seconds'
				break
			}
			case 'AddToTimestamp': {
				timeSelectorMode.value = 'For'
				timeSelectorAbsoluteTime.value = undefined
				timeSelectorDeltaValue.value = blockTimeManipulation.deltaToAdd
				timeSelectorDeltaUnit.value = blockTimeManipulation.deltaUnit
				break
			}
			case 'SetTimetamp': {
				timeSelectorMode.value = 'Until'
				timeSelectorAbsoluteTime.value = bigintSecondsToDate(blockTimeManipulation.timeToSet)
				timeSelectorDeltaValue.value = 12n
				timeSelectorDeltaUnit.value = 'Seconds'
				break
			}
			default: assertNever(blockTimeManipulation)
		}
	}, [blockTimeManipulation])

	const timeSelectorOnChange = (transactionOrMessage: SimulationStackTransactionRow | SimulationStackMessageRow) => {
		const blockTimeManipulation = getTimeManipulatorFromSignals(timeSelectorMode.value, timeSelectorAbsoluteTime.value, timeSelectorDeltaValue.value, timeSelectorDeltaUnit.value)
		if (blockTimeManipulation === undefined) return
		return sendPopupMessageToBackgroundPage({ method: 'popup_setTransactionOrMessageBlockTimeManipulator', data: { transactionOrMessageIdentifier: getStackRowIdentifier(transactionOrMessage), blockTimeManipulation } })
	}
	const stackRowWrapperProps = {
		id: stackRowElementId,
		class: `simulation-stack-row${ highlightStackRow ? ' simulation-stack-row--highlighted' : '' }`,
	}
	if (displayMode === 'titleOnly') return <>
		<div { ...stackRowWrapperProps }>
			<TransactionOrMessageTitleOnlyCard
				stackRow = { stackRow }
				removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
				openSimulationStackAt = { openSimulationStackAt }
			/>
		</div>
		{ showTimePicker ? <div style = 'display: flex; justify-content: center; padding-top: 10px;'>
			<TimePicker
				startText = { 'Simulate delay' }
				mode = { timeSelectorMode }
				absoluteTime = { timeSelectorAbsoluteTime }
				deltaValue = { timeSelectorDeltaValue }
				deltaUnit = { timeSelectorDeltaUnit }
				onChangedCallBack = { () => { timeSelectorOnChange(stackRow) } }
				removeNoDelayOption = { false }
			/>
		</div> : <></> }
	</>
	return <>
		<div { ...stackRowWrapperProps }>
			{ stackRow.type === 'Message' ? <>
				{ stackRow.status === 'simulated' && stackRow.visualizedPersonalSignRequest !== undefined ?
					<SignatureCard
						visualizedPersonalSignRequest = { stackRow.visualizedPersonalSignRequest }
						renameAddressCallBack = { renameAddressCallBack }
						removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
						editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
						numberOfUnderTransactions = { 0 }
						collapsed = { collapsed.value }
						toggleCollapsed = { toggleCollapsed }
					/>
				: <MessagePreviewDetails
					website = { stackRow.signedMessageTransaction.website }
					created = { stackRow.signedMessageTransaction.created }
					signedMessageTransaction = { stackRow.signedMessageTransaction }
					visualizedPersonalSignRequest = { stackRow.visualizedPersonalSignRequest }
					errorMessage = { undefined }
					collapsed = { collapsed.value }
					toggleCollapsed = { toggleCollapsed }
				/> }
				</> : <>
					{ stackRow.status === 'simulated' && stackRow.simulatedTransaction !== undefined && currentSimulationAndVisualisationResults !== undefined ?
						<Transaction
							simTx = { stackRow.simulatedTransaction }
							simulationAndVisualisationResults = { currentSimulationAndVisualisationResults }
							removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
							activeAddress = { activeAddress }
							renameAddressCallBack = { renameAddressCallBack }
							addressMetaData = { addressMetaData }
							editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
							collapsed = { collapsed.value }
							toggleCollapsed = { toggleCollapsed }
						/>
				: <TransactionPreviewDetails
					website = { stackRow.preSimulationTransaction.website }
					created = { stackRow.preSimulationTransaction.created }
					originalRequestParameters = { stackRow.preSimulationTransaction.originalRequestParameters }
					signedTransaction = { stackRow.preSimulationTransaction.signedTransaction }
					parsedInputData = { stackRow.simulatedTransaction?.parsedInputData }
					addressMetaData = { addressMetaData }
					renameAddressCallBack = { renameAddressCallBack }
					errorMessage = { stackRow.status === 'failed' ? (stackRow.simulatedTransaction as NonSimulatedAndVisualizedTransaction | undefined)?.error.decodedErrorMessage ?? 'Failed to simulate this transaction.' : undefined }
					title = { stackRow.status === 'failed' ? 'Not simulated' : 'Pending transaction' }
					collapsed = { collapsed.value }
					toggleCollapsed = { toggleCollapsed }
				/> }
			</> }
		</div>
		{ showTimePicker ? <div style = 'display: flex; justify-content: center; padding-top: 10px;'>
			<TimePicker
				startText = { 'Simulate delay' }
				mode = { timeSelectorMode }
				absoluteTime = { timeSelectorAbsoluteTime }
				deltaValue = { timeSelectorDeltaValue }
				deltaUnit = { timeSelectorDeltaUnit }
				onChangedCallBack = { () => { timeSelectorOnChange(stackRow) } }
				removeNoDelayOption = { false }
			/>
		</div> : <></> }
	</>
}

type TransactionsAndSignedMessagesParams = {
	simulationAndVisualisationResults: ReadonlySignal<ResolvedSimulationResults>
	removeTransactionOrSignedMessage?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	activeAddress: ReadonlySignal<bigint | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
	showTimePicker?: boolean
	displayMode?: 'full' | 'titleOnly'
	openSimulationStackAt?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	highlightedStackTargetId?: ReadonlySignal<string | undefined>
}

export function TransactionsAndSignedMessages(param: TransactionsAndSignedMessagesParams) {
	const simulationAndVisualisationResults = useComputed(() => {
		const currentResults = param.simulationAndVisualisationResults.value
		return currentResults.kind === 'passthrough' ? undefined : currentResults.value
	})
	return <SimulationStackRows { ...param } simulationAndVisualisationResults = { simulationAndVisualisationResults } showTimePicker = { param.showTimePicker !== false } />
}

type SimulationStackRowsParams = Omit<TransactionsAndSignedMessagesParams, 'simulationAndVisualisationResults'> & {
	simulationAndVisualisationResults: ReadonlySignal<SimulationAndVisualisationResults | undefined>
}

// Shared so rows without a delay keep the same prop identity across renders and do not resync their time picker on every render.
const NO_BLOCK_TIME_MANIPULATION = { type: 'No Delay' } as const

export function SimulationStackRows(param: SimulationStackRowsParams) {
	const transactionsAndMessagesInBlock = useComputed(() => {
		const results = param.simulationAndVisualisationResults.value
		if (results === undefined || results.simulationStateInput === undefined) return []
		return normalizeSimulationStackRows(
			results.simulationStateInput,
			results.visualizedSimulationState,
		)
	})
	return <ul class = 'simulation-stack-list'> {
		transactionsAndMessagesInBlock.value.flatMap((block, blockIndex) => {
			const nextBlockManipulator = transactionsAndMessagesInBlock.value[blockIndex + 1]?.blockTimeManipulation || NO_BLOCK_TIME_MANIPULATION
			return block.rows.map((stackRow, transactionIndex) => {
				const stackRowElementId = getSimulationStackElementId(getStackRowIdentifier(stackRow))
				return <li
					key = { stackRow.type === 'Message' ? `message-${ stackRow.signedMessageTransaction.messageIdentifier.toString() }` : `transaction-${ stackRow.preSimulationTransaction.transactionIdentifier.toString() }` }
				>
					<TransactionOrMessageWithBlockTimeManipulator
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						stackRow = { stackRow }
						renameAddressCallBack = { param.renameAddressCallBack }
						editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
						removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
						activeAddress = { param.activeAddress }
						addressMetaData = { param.addressMetaData }
						blockTimeManipulation = { transactionIndex === block.rows.length - 1 ? nextBlockManipulator : NO_BLOCK_TIME_MANIPULATION }
						showTimePicker = { param.showTimePicker !== false }
						displayMode = { param.displayMode }
						openSimulationStackAt = { param.openSimulationStackAt }
						stackRowElementId = { stackRowElementId }
						highlightStackRow = { param.highlightedStackTargetId?.value === stackRowElementId }
					/>
				</li>
			})
			})
		} </ul>
	}
