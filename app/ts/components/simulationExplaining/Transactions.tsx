import type { BlockTimeManipulationWithNoDelay, MaybeSimulatedTransaction, ResolvedSimulationResults, SimulationAndVisualisationResults, TransactionVisualizationParameters } from '../../types/visualizer-types.js'
import { SmallAddress } from '../subcomponents/address.js'
import type { NonSimulatedAndVisualizedTransaction, SignedMessageTransaction } from '../../types/visualizer-types.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import { TokenSymbol, TokenAmount, AllApproval } from '../subcomponents/coins.js'
import type { LogAnalysisParams, NonLogAnalysisParams, RenameAddressCallBack } from '../../types/user-interface-types.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { identifyRoutes, identifySwap, SwapVisualization } from './SwapTransactions.js'
import { RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, TransactionCreated, TransactionHeader, TransactionHeaderForFailedToSimulate, NonTokenLogAnalysisCard, TransactionsAccountChangesCard } from './SimulationSummary.js'
import { identifyTransaction } from './identifyTransaction.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import { SimpleTokenTransferVisualisation } from './customExplainers/SimpleSendVisualisations.js'
import { SimpleTokenApprovalVisualisation } from './customExplainers/SimpleTokenApprovalVisualisation.js'
import { assertNever } from '../../utils/typescript.js'
import { CatchAllVisualizer, tokenEventToTokenSymbolParams } from './customExplainers/CatchAllVisualizer.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { SignatureCard, SignatureHeader } from '../pages/PersonalSign.js'
import { bigintSecondsToDate, bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { GovernanceVoteVisualizer } from './customExplainers/GovernanceVoteVisualizer.js'
import { EnrichedSolidityTypeComponentWithAddressBook, StringElement } from '../subcomponents/solidityType.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { ProxyTokenTransferVisualisation } from './customExplainers/ProxySendVisualisations.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { type EditEnsNamedHashCallBack, EnsNamedHashComponent } from '../subcomponents/ens.js'
import { insertBetweenElements } from '../subcomponents/misc.js'
import type { EnrichedEthereumEventWithMetadata, EnrichedEthereumInputData, TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import { type DeltaUnit, TimePicker, type TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import type { VisualizedPersonalSignRequest } from '../../types/personal-message-definitions.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { useEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { SignalOrValue } from '../../utils/signals.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import { checksummedAddress, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { normalizeSimulationStackRows, type SimulationStackMessageRow, type SimulationStackTransactionRow } from './simulationStackRows.js'
import type { OriginalSendRequestParameters } from '../../types/JsonRpc-types.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { EthereumSendableSignedTransaction } from '../../types/wire-types.js'
import { Blockie } from '../subcomponents/SVGBlockie.js'
import { getSimulationStackElementId } from '../../utils/simulationStackTargets.js'

function isPositiveEvent(visResult: TokenVisualizerResultWithMetadata, ourAddressInReferenceFrame: bigint) {
	if (visResult.type === 'ERC20') {
		if (!visResult.isApproval) {
			return visResult.amount >= 0 // simple transfer
		}
		return visResult.amount === 0n // zero is only positive approve event
	}

	// nfts
	if (visResult.type === 'NFT All approval') { // all approval is only positive if someone all approves us, or all approval is removed from us
		return (visResult.allApprovalAdded && visResult.to.address === ourAddressInReferenceFrame) || (!visResult.allApprovalAdded && visResult.from.address === ourAddressInReferenceFrame)
	}

	if (visResult.isApproval) {
		return visResult.to.address === ourAddressInReferenceFrame // approval is only positive if we are getting approved
	}

	return visResult.to.address === ourAddressInReferenceFrame // send is positive if we are receiving
}

export function QuarantineReasons({ quarantineReasons }: { quarantineReasons: readonly string[] }) {
	return <> {
		quarantineReasons.map((quarantineReason, index) => <ErrorComponent key = { `${ quarantineReason }-${ index }` } text = { quarantineReason } containerStyle = { { margin: '0px', 'margin-top': '10px', 'margin-bottom': '10px' } }/>)
	} </>
}

export type TransactionImportanceBlockParams = {
	simTx: MaybeSimulatedTransaction
	activeAddress: ReadonlySignal<bigint | undefined>
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	addressMetadata: ReadonlySignal<readonly AddressBookEntry[]>
	rpcNetwork: ReadonlySignal<RpcNetwork>
}

function DelegationFlowArrow() {
	return <div aria-hidden = 'true' class = 'delegation-flow-arrow'>
		<ArrowIcon color = 'var(--subtitle-text-color)' />
	</div>
}

function CompactDelegationAddress({ addressBookEntry }: { addressBookEntry: AddressBookEntry }) {
	const address = checksummedAddress(addressBookEntry.address)
	const showSecondaryLine = addressBookEntry.name !== address
	return <div class = 'delegation-flow-address' title = { address }>
		<span class = 'delegation-flow-address-icon'>
			<Blockie address = { addressBookEntry.address } />
		</span>
		<span class = 'delegation-flow-address-text'>
			<span class = 'delegation-flow-address-primary'>{ addressBookEntry.name }</span>
			{ showSecondaryLine ? <span class = 'delegation-flow-address-secondary'>{ address }</span> : <></> }
		</span>
	</div>
}

function DelegationNotice({ defaultSigner, authorizationList, addressMetadata, renameAddressCallBack }: {
	defaultSigner: AddressBookEntry
	authorizationList: readonly { address: bigint, authority?: bigint, delegateEntry?: AddressBookEntry }[]
	addressMetadata: ReadonlySignal<readonly AddressBookEntry[]>
	renameAddressCallBack: RenameAddressCallBack
}) {
	return <div class = 'delegation-flow-banner'>
		<div class = 'delegation-flow-header'>
			<a
				class = 'tag delegation-flow-badge'
				href = 'https://eips.ethereum.org/EIPS/eip-7702'
				target = '_blank'
				rel = 'noreferrer'
			>
				7702
			</a>
			<p class = 'paragraph delegation-flow-title'>Delegated execution</p>
		</div>
		<div class = 'delegation-flow-column'>
			{ authorizationList.map((authorization, index) => {
				const signer = authorization.authority === undefined ? defaultSigner : getAddressBookEntryOrAFiller(addressMetadata.value, authorization.authority)
				const delegate = authorization.delegateEntry ?? getAddressBookEntryOrAFiller(addressMetadata.value, authorization.address)
				return <div class = 'delegation-flow-row' key = { `${ authorization.address.toString() }-${ authorization.authority?.toString() ?? defaultSigner.address.toString() }-${ index }` }>
					<button type = 'button' class = 'delegation-flow-address-button' onClick = { () => renameAddressCallBack(signer) }>
						<CompactDelegationAddress addressBookEntry = { signer } />
					</button>
					<div class = 'delegation-flow-connector'>
						<p class = 'paragraph delegation-flow-label'>{ authorization.address === 0n ? 'cleared delegate' : 'delegated to' }</p>
						<DelegationFlowArrow />
					</div>
					<div class = 'delegation-flow-targets'>
						<button type = 'button' class = 'delegation-flow-address-button' onClick = { () => renameAddressCallBack(delegate) }>
							<CompactDelegationAddress addressBookEntry = { delegate } />
						</button>
					</div>
				</div>
			}) }
		</div>
	</div>
}

function getDelegationNotice(
	transaction: MaybeSimulatedTransaction['transaction'],
	addressMetadata: ReadonlySignal<readonly AddressBookEntry[]>,
	renameAddressCallBack: RenameAddressCallBack
) {
	if (transaction.type === '7702' && transaction.authorizationList.length > 0) return <DelegationNotice
		defaultSigner = { transaction.from }
		authorizationList = { transaction.authorizationList }
		addressMetadata = { addressMetadata }
		renameAddressCallBack = { renameAddressCallBack }
	/>
	if (transaction.delegationAddress === undefined) return undefined
	return <DelegationNotice
		defaultSigner = { transaction.from }
		authorizationList = { [{ address: transaction.delegationAddress.address, delegateEntry: transaction.delegationAddress }] }
		addressMetadata = { addressMetadata }
		renameAddressCallBack = { renameAddressCallBack }
	/>
}

function ConnectedDelegationStack({ delegationNotice, children }: { delegationNotice: ComponentChildren, children: ComponentChildren }) {
	if (delegationNotice === undefined || delegationNotice === null) return <>{ children }</>
	return <div style = 'display: grid; gap: 8px;'>
		{ delegationNotice }
		{ children }
	</div>
}

// showcases the most important things the transaction does
export function TransactionImportanceBlock(param: TransactionImportanceBlockParams) {
	const delegationNotice = getDelegationNotice(param.simTx.transaction, param.addressMetadata, param.renameAddressCallBack)
	const content = (() => {
		if (param.simTx.transactionStatus === 'Failed To Simulate') return <ErrorComponent text = { 'Failed to simulate this transaction.' } containerStyle = { { margin: '0px' } } />
		if (param.simTx.transactionStatus === 'Transaction Failed') return <ErrorComponent text = { `The transaction fails with an error: '${ param.simTx.error.decodedErrorMessage }' ${ param.simTx.error.data !== undefined ? ` (data: '${ param.simTx.error.data }')` : '' }` } containerStyle = { { margin: '0px' } } />
		const transactionIdentification = identifyTransaction(param.simTx)
		switch (transactionIdentification.type) {
			case 'SimpleTokenTransfer': return <SimpleTokenTransferVisualisation simTx = { transactionIdentification.identifiedTransaction } renameAddressCallBack = { param.renameAddressCallBack }/>
			case 'SimpleTokenApproval': {
				const approval = transactionIdentification.identifiedTransaction.events[0]
				if (approval === undefined || approval.type !== 'TokenEvent') throw new Error('approval was undefined')
				return <SimpleTokenApprovalVisualisation
					approval = { approval.logInformation }
					transactionGasses = { transactionIdentification.identifiedTransaction }
					rpcNetwork = { transactionIdentification.identifiedTransaction.transaction.rpcNetwork }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			}
			case 'Swap': {
				const identifiedSwap = identifySwap(param.simTx)
				if (identifiedSwap === undefined) throw new Error('Not a swap!')
				return <SwapVisualization identifiedSwap = { identifiedSwap } renameAddressCallBack = { param.renameAddressCallBack }/>
			}
			case 'ProxyTokenTransfer': return <ProxyTokenTransferVisualisation simTx = { transactionIdentification.identifiedTransaction } renameAddressCallBack = { param.renameAddressCallBack }/>
			case 'ContractDeployment':
			case 'ContractFallbackMethod':
			case 'ArbitraryContractExecution': return <CatchAllVisualizer editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } simTx = { param.simTx } renameAddressCallBack = { param.renameAddressCallBack } addressMetadata = { param.addressMetadata } rpcNetwork = { param.rpcNetwork }/>
			case 'GovernanceVote': return <GovernanceVoteVisualizer editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } activeAddress = { param.activeAddress } simTx = { param.simTx } governanceVoteInputParameters = { transactionIdentification.governanceVoteInputParameters } renameAddressCallBack = { param.renameAddressCallBack }/>
			default: assertNever(transactionIdentification)
		}
	})()
	return <ConnectedDelegationStack delegationNotice = { delegationNotice }>{ content }</ConnectedDelegationStack>
}

export function SenderReceiver({ from, to, renameAddressCallBack }: { from: AddressBookEntry, to: AddressBookEntry | undefined, renameAddressCallBack: (entry: AddressBookEntry) => void, }) {
	const textColor = 'var(--text-color)'
	if (to === undefined) {
		return <span class = 'log-table' style = 'margin-top: 10px; column-gap: 5px; justify-content: space-between; grid-template-columns: auto auto'>
			<div class = 'log-cell' style = ''>
				<p style = { 'color: var(--subtitle-text-color);' }> Transaction sender: </p>
			</div>
			<div class = 'log-cell' style = ''>
				<SmallAddress
					addressBookEntry = { from }
					textColor = { 'var(--subtitle-text-color)' }
					renameAddressCallBack = { renameAddressCallBack }
				/>
			</div>
		</span>
	}
	return <span class = 'log-table' style = 'justify-content: space-between; column-gap: 5px; grid-template-columns: auto auto auto;'>
		<div class = 'log-cell' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { from }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em; justify-content: center;'>
			<ArrowIcon color = { textColor } />
		</div>
		<div class = 'log-cell' style = 'margin: 2px; justify-content: end;'>
			<SmallAddress
				addressBookEntry = { to }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
	</span>
}

type CollapsibleStackCardParams = {
	collapsed?: boolean
	toggleCollapsed?: () => void
}

export function Transaction(param: TransactionVisualizationParameters & CollapsibleStackCardParams) {
	const removeTransactionOrSignedMessage = param.removeTransactionOrSignedMessage
	const remove = removeTransactionOrSignedMessage === undefined ? undefined : () => {
		return removeTransactionOrSignedMessage({ type: 'Transaction', transactionIdentifier: param.simTx.transactionIdentifier })
	}
	const headerActionLabel = param.collapsed === undefined ? undefined : param.collapsed ? 'Expand transaction details' : 'Collapse transaction details'
	const rpcNetwork = useSignal(param.simulationAndVisualisationResults.rpcNetwork)
	useEffect(() => {
		rpcNetwork.value = param.simulationAndVisualisationResults.rpcNetwork
	}, [param.simulationAndVisualisationResults.rpcNetwork])
	return (
		<div class = 'card'>
			<TransactionHeader
				simTx = { param.simTx }
				removeTransactionOrSignedMessage = { remove }
				onHeaderClick = { param.toggleCollapsed }
				headerActionLabel = { headerActionLabel }
				ariaExpanded = { param.collapsed === undefined ? undefined : !param.collapsed }
			/>
			{ param.collapsed === true ? <></> : <div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<TransactionImportanceBlock { ...param } rpcNetwork = { rpcNetwork } addressMetadata = { param.addressMetaData }/>
				</div>
				{ param.simTx.transactionStatus === 'Failed To Simulate' ? <></> : <>
					<QuarantineReasons quarantineReasons = { param.simTx.quarantineReasons }/>
					<TransactionsAccountChangesCard
						simTx = { param.simTx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						activeAddress = { param.activeAddress }
						renameAddressCallBack = { param.renameAddressCallBack }
						addressMetaData = { param.addressMetaData }
					/>
					<TokenLogAnalysisCard simTx = { param.simTx } renameAddressCallBack = { param.renameAddressCallBack } />
					<NonTokenLogAnalysisCard simTx = { param.simTx } renameAddressCallBack = { param.renameAddressCallBack } addressMetaData = { param.addressMetaData } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }/>
				</> }
				<RawTransactionDetailsCard isRawTransaction = { param.simTx.originalRequestParameters.method === 'eth_sendRawTransaction' } transaction = { param.simTx.transaction } transactionIdentifier = { param.simTx.transactionIdentifier } parsedInputData = { param.simTx.parsedInputData } renameAddressCallBack = { param.renameAddressCallBack } gasSpent = { 'gasSpent' in param.simTx ? param.simTx.gasSpent : undefined } addressMetaData = { param.addressMetaData } />
				<SenderReceiver from = { param.simTx.transaction.from } to = { param.simTx.transaction.to } renameAddressCallBack = { param.renameAddressCallBack }/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
					<div class = 'log-cell'>
						<TransactionCreated created = { param.simTx.created } />
					</div>
					<div class = 'log-cell' style = { { display: 'inline-flex', justifyContent: 'right' } }>
						{ param.simTx.transactionStatus === 'Failed To Simulate' ? <></> : <>
							<GasFee tx = { param.simTx } rpcNetwork = { rpcNetwork } />
						</> }
					</div>
				</span>
			</div> }
		</div>
	)
}

export function PendingStackHeader({ title, website, statusIcon, onHeaderClick, openLabel, ariaExpanded } : { title: string, website: SignalOrValue<Website | undefined>, statusIcon: string, onHeaderClick?: () => void, openLabel?: string, ariaExpanded?: boolean }) {
	return <header
		class = { `card-header stack-card-header${ onHeaderClick === undefined ? '' : ' stack-row-link-header' }` }
		onClick = { onHeaderClick }
		onKeyDown = { (event) => {
			if (onHeaderClick === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
			if (event.target !== event.currentTarget) return
			event.preventDefault()
			onHeaderClick()
		} }
		role = { onHeaderClick === undefined ? undefined : 'button' }
		tabIndex = { onHeaderClick === undefined ? undefined : 0 }
		title = { onHeaderClick === undefined ? undefined : openLabel }
		aria-label = { onHeaderClick === undefined ? undefined : openLabel }
		aria-expanded = { onHeaderClick === undefined ? undefined : ariaExpanded }
	>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { statusIcon } width = '24' height = '24' />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			<span class = 'card-header-title-text'>{ title }</span>
		</p>
		<WebsiteOriginText website = { website } class = 'card-header-website' />
	</header>
}

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
					<dd>{ `${ signedTransaction.value.toString(10) } wei` }</dd>
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
	}, [stackRow, blockTimeManipulation])

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
			const nextBlockManipulator = transactionsAndMessagesInBlock.value[blockIndex + 1]?.blockTimeManipulation || { type: 'No Delay' } as const
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
						blockTimeManipulation = { transactionIndex === block.rows.length - 1 ? nextBlockManipulator : { type: 'No Delay' } as const }
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

type TokenLogEventParams = {
	tokenVisualizerResult: TokenVisualizerResultWithMetadata
	ourAddressInReferenceFrame: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

function TokenLogEvent(params: TokenLogEventParams ) {
	const style = { color: isPositiveEvent(params.tokenVisualizerResult, params.ourAddressInReferenceFrame) ? 'var(--dim-text-color)' : 'var(--negative-dim-color)' }

	return <>
		<div class = 'log-cell' style = 'justify-content: right;'>
			{ params.tokenVisualizerResult.type === 'NFT All approval' ?
				<AllApproval
					{ ...params.tokenVisualizerResult }
					style = { style }
					fontSize = 'normal'
				/>
			: <> { 'amount' in params.tokenVisualizerResult && params.tokenVisualizerResult.amount >= (2n ** 96n - 1n ) && params.tokenVisualizerResult.isApproval ?
					<p class = 'ellipsis' style = { `color: ${ style.color }` }><b>ALL</b></p>
				:
					'amount' in params.tokenVisualizerResult ?
						<TokenAmount
							amount = { params.tokenVisualizerResult.amount }
							tokenEntry = { params.tokenVisualizerResult.token }
							style = { style }
							fontSize = 'normal'
						/>
					: <></>
				} </>
			}
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em'>
			<TokenSymbol
				{ ...tokenEventToTokenSymbolParams(params.tokenVisualizerResult) }
				style = { style }
				useFullTokenName = { false }
				renameAddressCallBack = { params.renameAddressCallBack }
				fontSize = 'normal'
			/>
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.from }
				textColor = { style.color }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			{ params.tokenVisualizerResult.isApproval ? <ApproveIcon color = { style.color } /> : <ArrowIcon color = { style.color } /> }
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.to }
				textColor = { style.color }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
	</>
}

export function TokenLogAnalysis(param: LogAnalysisParams) {
	const tokenEvents = extractTokenEvents(param.simulatedAndVisualizedTransaction.events)

	if (tokenEvents.length === 0) return <p class = 'paragraph'> No token events </p>
	const routes = identifyRoutes(param.simulatedAndVisualizedTransaction, param.identifiedSwap)
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'> { routes ?
		routes.map((tokenVisualizerResult, index) => (
			<TokenLogEvent
				key = { index }
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	:
		tokenEvents.map((tokenEvent, index) => (
			<TokenLogEvent
				key = { index }
				tokenVisualizerResult = { tokenEvent }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	} </span>
}

type NonTokenLogEventParams = {
	nonTokenLog: EnrichedEthereumEventWithMetadata
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
	renameAddressCallBack: RenameAddressCallBack
	readonly editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

function NonTokenLogEvent(params: NonTokenLogEventParams) {
	const cellStyle = 'align-items: normal;'
	const textStyle = 'text-overflow: ellipsis; overflow: hidden;'
	if (params.nonTokenLog.isParsed === 'NonParsed') {
		return <>
			<div class = 'log-cell' style = { cellStyle }>
				<SmallAddress
					addressBookEntry = { getAddressBookEntryOrAFiller(params.addressMetaData.value, params.nonTokenLog.address) }
					renameAddressCallBack = { params.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell' style = { cellStyle }>
				<p class = 'paragraph' style = { textStyle }> { dataStringWith0xStart(params.nonTokenLog.data) } </p>
			</div>
			<div class = 'log-cell' style = { 'grid-column: 2 / 4; display: flex; flex-wrap: wrap;' } >
				{ params.nonTokenLog.topics.map((topic, index) => <p key = { `${ bytes32String(topic) }-${ index }` } class = 'paragraph' style = { textStyle }> { bytes32String(topic) } </p>) }
			</div>
		</>
	}
	return <>
			<div class = 'log-cell' style = { cellStyle }>
				<SmallAddress
					addressBookEntry = { getAddressBookEntryOrAFiller(params.addressMetaData.value, params.nonTokenLog.address) }
					renameAddressCallBack = { params.renameAddressCallBack }
				/>
		</div>
		<div style = 'display: contents;'/>
		<div class = 'log-cell' style = { { 'grid-column-start': 2, 'grid-column-end': 4, display: 'flex', 'flex-wrap': 'wrap' } }>
			<p class = 'paragraph' style = { textStyle }> { `${ params.nonTokenLog.name }(` } </p>
			{ insertBetweenElements(params.nonTokenLog.args.map((arg) => {
				if (arg.paramName === 'node' && 'logInformation' in params.nonTokenLog && 'node' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
						<EnsNamedHashComponent type = 'nameHash' nameHash = { params.nonTokenLog.logInformation.node.nameHash } name = { params.nonTokenLog.logInformation.node.name } editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }/>
					</>
				}
				if ((arg.paramName === 'id' || arg.paramName === 'label') && 'logInformation' in params.nonTokenLog && 'labelHash' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
						<EnsNamedHashComponent type = 'labelHash' nameHash = { params.nonTokenLog.logInformation.labelHash.labelHash } name = { params.nonTokenLog.logInformation.labelHash.label } editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }/>
					</>
				}
				if (arg.paramName === 'fuses' && 'logInformation' in params.nonTokenLog && 'fuses' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } = [` }</p>
						<StringElement text = { params.nonTokenLog.logInformation.fuses.join(', ') } />
						<p style = { textStyle } class = 'paragraph'>]</p>
					</>
				}
				return <>
					<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
					<EnrichedSolidityTypeComponentWithAddressBook valueType = { arg.typeValue } addressMetaData = { params.addressMetaData } renameAddressCallBack = { params.renameAddressCallBack } />
				</>
			}), <p style = { textStyle } class = 'paragraph'>,&nbsp;</p>) }
			<p class = 'paragraph' style = { textStyle }> { ')' } </p>
		</div>
	</>
}

export function NonTokenLogAnalysis(param: NonLogAnalysisParams) {
	if (param.nonTokenLogs.length === 0) return <p class = 'paragraph'> No non-token events </p>
	return <span class = 'nontoken-log-table' style = 'justify-content: center; column-gap: 5px; row-gap: 5px;'>
		{ param.nonTokenLogs.map((nonTokenLog, index) => <NonTokenLogEvent key = { index } nonTokenLog = { nonTokenLog } addressMetaData = { param.addressMetaData } renameAddressCallBack = { param.renameAddressCallBack } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }/> ) }
	</span>
}

type ParsedInputDataParams = {
	inputData: EnrichedEthereumInputData
	addressMetaData: SignalOrValue<readonly AddressBookEntry[]>
	renameAddressCallBack: RenameAddressCallBack
}

export function ParsedInputData(params: ParsedInputDataParams) {
	const textStyle = 'text-overflow: ellipsis; overflow: hidden;'
	if (params.inputData.type === 'NonParsed') {
		return <div class = 'textbox'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(params.inputData.input) }</p>
		</div>
	}
	return <>
		<div class = 'log-cell' style = { { 'grid-column-start': 2, 'grid-column-end': 4, display: 'flex', 'flex-wrap': 'wrap' } }>
			<p class = 'paragraph' style = { textStyle }> { `${ params.inputData.name }(` } </p>
			{ insertBetweenElements(params.inputData.args.map((arg) => {
				return <>
					<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
					<EnrichedSolidityTypeComponentWithAddressBook valueType = { arg.typeValue } addressMetaData = { params.addressMetaData } renameAddressCallBack = { params.renameAddressCallBack } />
				</>
			}), <p style = { textStyle } class = 'paragraph'>,&nbsp;</p>) }
			<p class = 'paragraph' style = { textStyle }> { ')' } </p>
		</div>
	</>
}
