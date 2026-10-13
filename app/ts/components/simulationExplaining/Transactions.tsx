import type { MaybeSimulatedTransaction, TransactionVisualizationParameters } from '../../types/visualizer-types.js'
import { SmallAddress } from '../subcomponents/address.js'
import { WebsiteOriginText } from '../subcomponents/address.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { identifySwap, SwapVisualization } from './SwapTransactions.js'
import { RawTransactionDetailsCard, GasFee, TokenLogAnalysisCard, TransactionCreated, TransactionHeader, NonTokenLogAnalysisCard, TransactionsAccountChangesCard } from './SimulationSummary.js'
import { identifyTransaction } from './identifyTransaction.js'
import { ArrowIcon } from '../subcomponents/icons.js'
import { SimpleTokenTransferVisualisation } from './customExplainers/SimpleSendVisualisations.js'
import { SimpleTokenApprovalVisualisation } from './customExplainers/SimpleTokenApprovalVisualisation.js'
import { assertNever } from '../../utils/typescript.js'
import { CatchAllVisualizer } from './customExplainers/CatchAllVisualizer.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { GovernanceVoteVisualizer } from './customExplainers/GovernanceVoteVisualizer.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { ProxyTokenTransferVisualisation } from './customExplainers/ProxySendVisualisations.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { type ReadonlySignal, useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { SignalOrValue } from '../../utils/signals.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { Blockie } from '../subcomponents/SVGBlockie.js'
import { getSimulatedTransactionInsufficientBalanceMessage } from '../../simulation/insufficientBalance.js'

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

type DelegationFlowEntry = {
	key: string
	signer: AddressBookEntry
	delegate: AddressBookEntry
	label: 'cleared delegate' | 'delegated to'
}

function DelegationNotice({ flows, renameAddressCallBack }: {
	flows: readonly DelegationFlowEntry[]
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
			{ flows.map((flow) => {
				return <div class = 'delegation-flow-row' key = { flow.key }>
					<button type = 'button' class = 'delegation-flow-address-button' onClick = { () => renameAddressCallBack(flow.signer) }>
						<CompactDelegationAddress addressBookEntry = { flow.signer } />
					</button>
					<div class = 'delegation-flow-connector'>
						<p class = 'paragraph delegation-flow-label'>{ flow.label }</p>
						<DelegationFlowArrow />
					</div>
					<div class = 'delegation-flow-targets'>
						<button type = 'button' class = 'delegation-flow-address-button' onClick = { () => renameAddressCallBack(flow.delegate) }>
							<CompactDelegationAddress addressBookEntry = { flow.delegate } />
						</button>
					</div>
				</div>
			}) }
		</div>
	</div>
}

const resolveDelegationFlows = (
	defaultSigner: AddressBookEntry,
	authorizations: readonly { address: bigint, authority?: bigint, delegateEntry?: AddressBookEntry }[],
	addressMetadata: readonly AddressBookEntry[],
): readonly DelegationFlowEntry[] => authorizations.map((authorization, index) => ({
	key: `${ authorization.address.toString() }-${ authorization.authority?.toString() ?? defaultSigner.address.toString() }-${ index }`,
	signer: authorization.authority === undefined ? defaultSigner : getAddressBookEntryOrAFiller(addressMetadata, authorization.authority),
	delegate: authorization.delegateEntry ?? getAddressBookEntryOrAFiller(addressMetadata, authorization.address),
	label: authorization.address === 0n ? 'cleared delegate' : 'delegated to',
}))

function getDelegationNotice(
	transaction: MaybeSimulatedTransaction['transaction'],
	addressMetadata: ReadonlySignal<readonly AddressBookEntry[]>,
	renameAddressCallBack: RenameAddressCallBack
) {
	if (transaction.type === '7702' && transaction.authorizationList.length > 0) return <DelegationNotice
		flows = { resolveDelegationFlows(transaction.from, transaction.authorizationList, addressMetadata.value) }
		renameAddressCallBack = { renameAddressCallBack }
	/>
	if (transaction.delegationAddress === undefined) return undefined
	return <DelegationNotice
		flows = { resolveDelegationFlows(transaction.from, [{ address: transaction.delegationAddress.address, delegateEntry: transaction.delegationAddress }], addressMetadata.value) }
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
		if (param.simTx.transactionStatus === 'Transaction Failed') return <ErrorComponent text = { getSimulatedTransactionInsufficientBalanceMessage(param.simTx) ?? `The transaction fails with an error: '${ param.simTx.error.decodedErrorMessage }' ${ param.simTx.error.data !== undefined ? ` (data: '${ param.simTx.error.data }')` : '' }` } containerStyle = { { margin: '0px' } } />
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
			case 'GovernanceVote': return <GovernanceVoteVisualizer transactionCard = { Transaction } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack } activeAddress = { param.activeAddress } simTx = { param.simTx } governanceVoteInputParameters = { transactionIdentification.governanceVoteInputParameters } renameAddressCallBack = { param.renameAddressCallBack }/>
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

export type CollapsibleStackCardParams = {
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
				{ param.simTx.safeTransaction === undefined ? <></> :
					<div class = 'notification is-info' style = 'margin-bottom: 10px;'>
						<p class = 'paragraph'><strong>Optimistic Gnosis Safe transaction</strong></p>
						<p class = 'paragraph'>Gnosis Safe nonce { param.simTx.safeTransaction.safeTx.message.nonce.toString() }; { param.simTx.safeTransaction.signatures.length } owner signature{ param.simTx.safeTransaction.signatures.length === 1 ? '' : 's' } collected. This optimistic preview simulates the Gnosis Safe calling the destination, but does not model Gnosis Safe guards, modules, events, nonce changes, executor-dependent behavior, or network gas. Nothing has necessarily been executed onchain.</p>
					</div>
				}
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
