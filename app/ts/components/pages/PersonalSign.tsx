import { Fragment } from 'preact'
import { MAX_DATE_SECONDS, bigintSecondsToDate } from '../../utils/bigint.js'
import { EthereumData } from '../../types/wire-types.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import { assertNever } from '../../utils/typescript.js'
import { TokenApprovalsVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { TokenSymbol } from '../subcomponents/coins.js'
import type { Permit2Witness, VisualizedPersonalSignRequest, VisualizedPersonalSignRequestPermit, VisualizedPersonalSignRequestPermit2, VisualizedPersonalSignRequestPermit2Batch, VisualizedPersonalSignRequestPermit2SignatureTransfer, VisualizedPersonalSignRequestSafeTx } from '../../types/personal-message-definitions.js'
import { OrderComponents, OrderComponentsExtraDetails } from '../simulationExplaining/customExplainers/OpenSeaOrder.js'
import { humanReadableDateFromSeconds, CellElement } from '../ui-utils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedEIP712, EnrichedEIP712Message, TypeEnrichedEIP712MessageRecord } from '../../types/eip721.js'
import { TransactionCreated } from '../simulationExplaining/SimulationSummary.js'
import { EnrichedSolidityTypeComponent } from '../subcomponents/solidityType.js'
import { QuarantineReasons } from '../simulationExplaining/Transactions.js'
import { GnosisSafeVisualizer } from '../simulationExplaining/customExplainers/GnosisSafeVisualizer.js'
import type { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { ViewSelector, ViewSelector as Viewer } from '../subcomponents/ViewSelector.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import { SafeTxSigningDetails } from '../subcomponents/SafeTxSigningDetails.js'
import { CollapsibleCard } from '../subcomponents/CollapsibleCard.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import type { ReadonlySignal } from '@preact/signals'
import type { PopupPendingTransactionOrSignableMessage as PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { identifySignature } from '../simulationExplaining/identifySignature.js'
import type { RpcNetwork } from '../../types/rpc.js'

type SignatureCardParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
	removeTransactionOrSignedMessage: ((transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void) | undefined
	numberOfUnderTransactions: number
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	collapsed?: boolean
	toggleCollapsed?: () => void
}

type SignatureHeaderParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	removeTransactionOrSignedMessage?: (transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void
	onHeaderClick?: () => void
	headerActionLabel?: string
	ariaExpanded?: boolean
}

export function SignatureHeader(params: SignatureHeaderParams) {
	const removeSignedMessage = params.removeTransactionOrSignedMessage
	return <header
		class = { `card-header stack-card-header${ params.onHeaderClick === undefined ? '' : ' stack-row-link-header' }` }
		onClick = { params.onHeaderClick }
		onKeyDown = { (event) => {
			if (params.onHeaderClick === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
			if (event.target !== event.currentTarget) return
			event.preventDefault()
			params.onHeaderClick()
		} }
		role = { params.onHeaderClick === undefined ? undefined : 'button' }
		tabIndex = { params.onHeaderClick === undefined ? undefined : 0 }
		title = { params.onHeaderClick === undefined ? undefined : params.headerActionLabel ?? 'Open this signature in the full simulation stack' }
		aria-label = { params.onHeaderClick === undefined ? undefined : params.headerActionLabel ?? 'Open this signature in the full simulation stack' }
		aria-expanded = { params.onHeaderClick === undefined ? undefined : params.ariaExpanded }
	>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { params.visualizedPersonalSignRequest.simulationMode ? '../img/head-simulating.png' : '../img/head-signing.png' } width = '24' height = '24' />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			<span class = 'card-header-title-text'>{ identifySignature(params.visualizedPersonalSignRequest).title }</span>
		</p>
		<WebsiteOriginText
			website = { params.visualizedPersonalSignRequest.website }
			class = { `card-header-website${ params.removeTransactionOrSignedMessage !== undefined ? ' card-header-website--flush' : ''}` }
		/>
		{ removeSignedMessage !== undefined
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { (event) => {
				event.stopPropagation()
				removeSignedMessage({ type: 'Message', messageIdentifier: params.visualizedPersonalSignRequest.messageIdentifier })
			} }>
				<XMarkIcon />
			</button>
			: <></>
		}
	</header>
}

type SignRequestParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

export const decodeMessage = (message: string) => {
	if (!message.startsWith('0x')) return message
	const parsedMessage = EthereumData.safeParse(message)
	if (parsedMessage.success) return new TextDecoder().decode(parsedMessage.value)
	return message
}

function isNinetyFivePercentNumbersOrASCII(input: string): boolean {
	const asciiCount = input.split('').filter(char => char.charCodeAt(0) <= 127).length
	const numberCount = input.split('').filter(char => !isNaN(Number(char))).length
	const validCount = asciiCount + numberCount
	return validCount / input.length >= 0.95
}

type PermitTokenAmount = { token: AddressBookEntry, amount: bigint }

type PermitTokenApprovalsParams = {
	owner: AddressBookEntry
	spender: AddressBookEntry
	tokenAmounts: readonly PermitTokenAmount[]
	rpcNetwork: RpcNetwork
	renameAddressCallBack: RenameAddressCallBack
}

type UnidentifiedPermitTokenApprovalsParams = {
	spender: AddressBookEntry
	tokenAmounts: readonly PermitTokenAmount[]
	renameAddressCallBack: RenameAddressCallBack
}

// A token can be unidentified when it has no code on the active chain or its metadata lookup failed, and the spender and amounts must stay visible even then.
function UnidentifiedPermitTokenApprovals({ spender, tokenAmounts, renameAddressCallBack }: UnidentifiedPermitTokenApprovalsParams) {
	const errorText = tokenAmounts.length === 1
		? 'The permitted token is not an identified ERC20 token, so its amount is shown as a raw value without decimals.'
		: 'These permitted tokens are not identified ERC20 tokens, so their amounts are shown as raw values without decimals.'
	return <>
		<ErrorComponent text = { errorText }/>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			<CellElement text = 'Spender: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { spender } renameAddressCallBack = { renameAddressCallBack }/> }/>
			{ tokenAmounts.map(({ token, amount }, index) => <Fragment key = { index }>
				<CellElement text = 'Token: '/>
				<CellElement text = { <SmallAddress addressBookEntry = { token } renameAddressCallBack = { renameAddressCallBack }/> }/>
				<CellElement text = 'Raw amount: '/>
				<CellElement text = { amount.toString(10) }/>
			</Fragment>) }
		</span>
	</>
}

// Identified ERC20 tokens keep their decimal adjusted approval display even when other tokens of the same batch are unidentified.
function PermitTokenApprovals({ owner, spender, tokenAmounts, rpcNetwork, renameAddressCallBack }: PermitTokenApprovalsParams) {
	const approvals = tokenAmounts.flatMap(({ token, amount }) => token.type === 'ERC20' ? [{ type: 'ERC20' as const, token, amount, from: owner, to: spender, isApproval: true, logObject: undefined }] : [])
	const unidentifiedTokenAmounts = tokenAmounts.filter(({ token }) => token.type !== 'ERC20')
	return <>
		{ approvals.length === 0 ? <></> : <TokenApprovalsVisualisation
			spender = { spender }
			approvals = { approvals }
			transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
			rpcNetwork = { rpcNetwork }
			renameAddressCallBack = { renameAddressCallBack }
		/> }
		{ unidentifiedTokenAmounts.length === 0 ? <></> : <UnidentifiedPermitTokenApprovals spender = { spender } tokenAmounts = { unidentifiedTokenAmounts } renameAddressCallBack = { renameAddressCallBack }/> }
	</>
}

function Permit2WitnessDetails({ witness, renameAddressCallBack }: { witness: Permit2Witness, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<p class = 'paragraph'>{ `This signature is only valid together with the following ${ witness.typeName } witness data:` }</p>
		<EIP712Table enrichedEIP712Message = { { [witness.fieldName]: witness.value } } renameAddressCallBack = { renameAddressCallBack } isSubTable = { false }/>
	</>
}

function SignRequest({ visualizedPersonalSignRequest, renameAddressCallBack, editEnsNamedHashCallBack }: SignRequestParams) {
	switch (visualizedPersonalSignRequest.type) {
		case 'NotParsed': {
			const decoded = decodeMessage(visualizedPersonalSignRequest.message)
			const isDecodedAsciiOrNumbers = isNinetyFivePercentNumbersOrASCII(decoded)
			return <Viewer id = 'personal_sign'>
				<Viewer.List>
					<Viewer.View title = 'View Raw' value = 'raw' isActive = { !isDecodedAsciiOrNumbers }>
						<div class = 'textbox'>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ visualizedPersonalSignRequest.message }</p>
						</div>
					</Viewer.View>
					<Viewer.View title = 'View Parsed' value = 'parsed' isActive = { isDecodedAsciiOrNumbers }>
						<div class = 'textbox'>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ decoded }</p>
						</div>
					</Viewer.View>
				</Viewer.List>
				<Viewer.Triggers />
			</Viewer>
		}
		case 'SafeTx': return <GnosisSafeVisualizer
			gnosisSafeMessage = { visualizedPersonalSignRequest }
			activeAddress = { visualizedPersonalSignRequest.activeAddress.address }
			renameAddressCallBack = { renameAddressCallBack }
			editEnsNamedHashCallBack = { editEnsNamedHashCallBack }
		/>
		case 'SafeMessage': return <>
			<p class = 'paragraph'>Approve an off-chain Safe owner signature. The app can publish this message and signature to the Safe message service. The Safe threshold must be met before the message is fully signed.</p>
			<p class = 'paragraph'>{ visualizedPersonalSignRequest.review.isTypedData ? 'EIP-712 typed message (domain, types and values):' : 'Message:' }</p>
			<div class = 'textbox'><p class = 'paragraph' style = 'white-space: pre-wrap'>{ visualizedPersonalSignRequest.review.text }</p></div>
		</>
		case 'EIP712': return <ArbitraryEIP712 enrichedEIP712 = { visualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack } />
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { visualizedPersonalSignRequest.message }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		// A permit authorizes transfers of whatever token address it names, so a token that isn't an identified ERC20 still gets its spender and raw amount shown, under an explicit warning (UnidentifiedPermitTokenApprovals), rather than only an error; tokens identified as ERC721 or ERC1155 are rejected in the background (identifyPermitToken).
		case 'Permit': return <PermitTokenApprovals
			owner = { visualizedPersonalSignRequest.owner }
			spender = { visualizedPersonalSignRequest.spender }
			tokenAmounts = { [{ token: visualizedPersonalSignRequest.verifyingContract, amount: visualizedPersonalSignRequest.message.message.value }] }
			rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'Permit2': return <PermitTokenApprovals
			owner = { visualizedPersonalSignRequest.account }
			spender = { visualizedPersonalSignRequest.spender }
			tokenAmounts = { [{ token: visualizedPersonalSignRequest.token, amount: visualizedPersonalSignRequest.message.message.details.amount }] }
			rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'Permit2Batch': return <PermitTokenApprovals
			owner = { visualizedPersonalSignRequest.account }
			spender = { visualizedPersonalSignRequest.spender }
			tokenAmounts = { visualizedPersonalSignRequest.details }
			rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'Permit2SignatureTransfer': return <>
			<PermitTokenApprovals
				owner = { visualizedPersonalSignRequest.account }
				spender = { visualizedPersonalSignRequest.spender }
				tokenAmounts = { visualizedPersonalSignRequest.permitted }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
			{ visualizedPersonalSignRequest.witness === undefined ? <></> : <Permit2WitnessDetails witness = { visualizedPersonalSignRequest.witness } renameAddressCallBack = { renameAddressCallBack }/> }
		</>
		default: assertNever(visualizedPersonalSignRequest)
	}
}

type EIP712Table = {
	enrichedEIP712Message: EnrichedEIP712Message
	renameAddressCallBack: RenameAddressCallBack
	isSubTable: boolean
}

type EIP712Entry = {
	name: string
	entry: TypeEnrichedEIP712MessageRecord | undefined
}

function EIP712Table({ enrichedEIP712Message, renameAddressCallBack, isSubTable }: EIP712Table) {
	function EIP712Value({ entry }: { entry: TypeEnrichedEIP712MessageRecord }) {
		if (entry.type === 'nestedArray') {
			return <span style = 'display: inline-flex; flex-wrap: wrap;'>
				[{
					entry.value.map((nestedEntry, index) => <span key = { index } style = 'display: inline-flex;'>
						{ index === 0 ? '' : ', ' }
						<EIP712Value entry = { nestedEntry }/>
					</span>)
				}]
			</span>
		}
		if (entry.type === 'record[]') {
			return <>{ entry.value.map((value, index) => <EIP712Table key = { index } enrichedEIP712Message = { value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>) }</>
		}
		if (entry.type === 'record') {
			return <EIP712Table enrichedEIP712Message = { entry.value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>
		}
		return <EnrichedSolidityTypeComponent valueType = { entry } renameAddressCallBack = { renameAddressCallBack }/>
	}
	function EIP712Entry({ name, entry }: EIP712Entry) {
		if (entry === undefined) return <></>
		return <>
			<CellElement text = { `${ name }: ` }/>
			<CellElement text = { <EIP712Value entry = { entry }/> }/>
		</>
	}
	return <span class = 'eip-712-table' style = { isSubTable ? 'justify-content: space-between;' : '' }>
		{ Object.entries(enrichedEIP712Message).map(([name, entry]) => <EIP712Entry key = { name } entry = { entry } name = { name }/>) }
	</span>
}

type ArbitraryEIP712Params = {
	enrichedEIP712: EnrichedEIP712
	renameAddressCallBack: RenameAddressCallBack
}

function ArbitraryEIP712({ enrichedEIP712, renameAddressCallBack }: ArbitraryEIP712Params) {
	return <>
		<EIP712Table
			enrichedEIP712Message = { enrichedEIP712.domain }
			renameAddressCallBack = { renameAddressCallBack }
			isSubTable = { false }
		/>
		<EIP712Table
			enrichedEIP712Message = { enrichedEIP712.message }
			renameAddressCallBack = { renameAddressCallBack }
			isSubTable = { false }
		/>
	</>
}

function PermitTimeRemaining({ timestampSeconds }: { timestampSeconds: bigint }) {
	// EIP-2612 and Permit2 accept deadlines and expirations beyond any representable date, such as the maximum uint256 deadline.
	if (timestampSeconds > MAX_DATE_SECONDS) return <>unlimited</>
	return <>
		<SomeTimeAgo priorTimestamp = { bigintSecondsToDate(timestampSeconds) } countBackwards = { true }/>
		{ ` (until ${ humanReadableDateFromSeconds(timestampSeconds) })` }
	</>
}

type PermitDomainDetailsParams = {
	chainId: bigint
	verifyingContract: AddressBookEntry
	renameAddressCallBack: RenameAddressCallBack
}

function PermitDomainDetails({ chainId, verifyingContract, renameAddressCallBack }: PermitDomainDetailsParams) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(chainId) }/>
		<CellElement text = 'Verifying contract: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { verifyingContract } renameAddressCallBack = { renameAddressCallBack }/> }/>
	</>
}

function SignatureHashes({ domainHash, messageHash }: { domainHash: string, messageHash: string }) {
	return <>
		<CellElement text = 'Domain Hash: '/>
		<CellElement text = { domainHash }/>
		<CellElement text = 'Message Hash: '/>
		<CellElement text = { messageHash }/>
	</>
}

function Permit2ExtraDetails({ permit2, renameAddressCallBack }: { permit2: VisualizedPersonalSignRequestPermit2, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<PermitDomainDetails chainId = { permit2.message.domain.chainId } verifyingContract = { permit2.verifyingContract } renameAddressCallBack = { renameAddressCallBack }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit2.message.message.details.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in: '/>
		<CellElement text = { <PermitTimeRemaining timestampSeconds = { permit2.message.message.sigDeadline }/> }/>
		<CellElement text = 'Spender can spend for: '/>
		<CellElement text = { <PermitTimeRemaining timestampSeconds = { permit2.message.message.details.expiration }/> }/>
		<SignatureHashes domainHash = { permit2.domainHash } messageHash = { permit2.messageHash }/>
	</>
}

// Shows the token like the approval box does, so look-alike tokens with the same symbol stay distinguishable by icon, address and untrusted marker.
function Permit2DetailsToken({ token, renameAddressCallBack }: { token: AddressBookEntry, renameAddressCallBack: RenameAddressCallBack }) {
	if (token.type === 'ERC20') return <TokenSymbol tokenEntry = { token } useFullTokenName = { false } renameAddressCallBack = { renameAddressCallBack } fontSize = 'normal'/>
	return <SmallAddress addressBookEntry = { token } renameAddressCallBack = { renameAddressCallBack }/>
}

function Permit2BatchExtraDetails({ permit2Batch, renameAddressCallBack }: { permit2Batch: VisualizedPersonalSignRequestPermit2Batch, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<PermitDomainDetails chainId = { permit2Batch.message.domain.chainId } verifyingContract = { permit2Batch.verifyingContract } renameAddressCallBack = { renameAddressCallBack }/>
		<CellElement text = 'Signature expires in: '/>
		<CellElement text = { <PermitTimeRemaining timestampSeconds = { permit2Batch.message.message.sigDeadline }/> }/>
		{ permit2Batch.details.map((details, index) => <Fragment key = { index }>
			<CellElement text = { <><Permit2DetailsToken token = { details.token } renameAddressCallBack = { renameAddressCallBack }/> nonce: </> }/>
			<CellElement text = { details.nonce.toString(10) }/>
			<CellElement text = { <>Spender can spend <Permit2DetailsToken token = { details.token } renameAddressCallBack = { renameAddressCallBack }/> for: </> }/>
			<CellElement text = { <PermitTimeRemaining timestampSeconds = { details.expiration }/> }/>
		</Fragment>) }
		<SignatureHashes domainHash = { permit2Batch.domainHash } messageHash = { permit2Batch.messageHash }/>
	</>
}

function Permit2SignatureTransferExtraDetails({ permit2SignatureTransfer, renameAddressCallBack }: { permit2SignatureTransfer: VisualizedPersonalSignRequestPermit2SignatureTransfer, renameAddressCallBack: RenameAddressCallBack }) {
	const { domain, message } = permit2SignatureTransfer.message
	return <>
		<PermitDomainDetails chainId = { domain.chainId } verifyingContract = { permit2SignatureTransfer.verifyingContract } renameAddressCallBack = { renameAddressCallBack }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { message.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in: '/>
		<CellElement text = { <PermitTimeRemaining timestampSeconds = { message.deadline }/> }/>
		<SignatureHashes domainHash = { permit2SignatureTransfer.domainHash } messageHash = { permit2SignatureTransfer.messageHash }/>
	</>
}

function PermitExtraDetails({ permit, renameAddressCallBack }: { permit: VisualizedPersonalSignRequestPermit, renameAddressCallBack: RenameAddressCallBack }) {
	const { domain, message } = permit.message
	return <>
		<PermitDomainDetails chainId = { domain.chainId } verifyingContract = { permit.verifyingContract } renameAddressCallBack = { renameAddressCallBack }/>
		<CellElement text = 'Owner: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { permit.owner } renameAddressCallBack = { renameAddressCallBack }/> }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { message.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in: '/>
		<CellElement text = { <PermitTimeRemaining timestampSeconds = { message.deadline }/> }/>
		<SignatureHashes domainHash = { permit.domainHash } messageHash = { permit.messageHash }/>
	</>
}

type ExtraDetailsCardParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

type GnosisSafeExtraDetailsParams = {
	visualizedPersonalSignRequestSafeTx: VisualizedPersonalSignRequestSafeTx
	renameAddressCallBack: RenameAddressCallBack
}

function GnosisSafeExtraDetails({ visualizedPersonalSignRequestSafeTx, renameAddressCallBack }: GnosisSafeExtraDetailsParams) {
	const { domainHash, messageHash, safeTxHash, verifyingContract, to, gasToken, refundReceiver } = visualizedPersonalSignRequestSafeTx
	// Spans the whole ExtraDetails grid so the full-width hashes and the input do not get squeezed into one grid column.
	return <div style = 'grid-column: 1 / -1'>
		<SafeTxSigningDetails
			safeTx = { visualizedPersonalSignRequestSafeTx.message }
			hashes = { { domainHash, messageHash, safeTxHash } }
			addressBookEntries = { { verifyingContract, to, gasToken, refundReceiver } }
			rpcNetwork = { visualizedPersonalSignRequestSafeTx.rpcNetwork }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color); margin-top: 10px'>Gnosis Safe meta transaction input: </p>
		<TransactionInput parsedInputData = { visualizedPersonalSignRequestSafeTx.parsedMessageData } to = { visualizedPersonalSignRequestSafeTx.to } input = { visualizedPersonalSignRequestSafeTx.parsedMessageData.input } addressMetaData = { visualizedPersonalSignRequestSafeTx.parsedMessageDataAddressBookEntries } renameAddressCallBack = { renameAddressCallBack }/>
	</div>
}


function ExtraDetailsInner({ visualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	switch(visualizedPersonalSignRequest.type) {
		case 'EIP712':
		case 'SafeMessage':
		case 'NotParsed': return <>
			<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
				{ visualizedPersonalSignRequest.type === 'NotParsed' ? <></> : <>
					<CellElement text = 'Domain Hash: '/>
					<CellElement text = { visualizedPersonalSignRequest.domainHash }/>
				</> }
				<CellElement text = 'Message Hash: '/>
				<CellElement text = { visualizedPersonalSignRequest.messageHash }/>
			</span>
		</>
		case 'OrderComponents': return <OrderComponentsExtraDetails orderComponents = { visualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack }/>
		case 'Permit': return <PermitExtraDetails permit = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		case 'Permit2': return <Permit2ExtraDetails permit2 = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		case 'Permit2Batch': return <Permit2BatchExtraDetails permit2Batch = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		case 'Permit2SignatureTransfer': return <Permit2SignatureTransferExtraDetails permit2SignatureTransfer = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		case 'SafeTx': return <GnosisSafeExtraDetails visualizedPersonalSignRequestSafeTx = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		default: assertNever(visualizedPersonalSignRequest)
	}
}


function ExtraDetails({ visualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	return <CollapsibleCard title = 'Extra details'>
		<div class = 'card-content'>
			<div class = 'container' style = 'margin-bottom: 10px;'>
				<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
					<ExtraDetailsInner visualizedPersonalSignRequest = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
				</span>
			</div>
		</div>
	</CollapsibleCard>
}

function RawMessage({ visualizedPersonalSignRequest }: ExtraDetailsCardParams) {
	return <CollapsibleCard title = 'Raw message'>
		<ViewSelector id = 'raw_message'>
			<ViewSelector.List>
				<ViewSelector.View title = 'View Parsed' value = 'parsed'>
					<pre> { decodeMessage(visualizedPersonalSignRequest.stringifiedMessage) }</pre>
				</ViewSelector.View>
				<ViewSelector.View title = 'View Raw' value = 'raw'>
					<pre>{ visualizedPersonalSignRequest.rawMessage }</pre>
				</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</ViewSelector>
	</CollapsibleCard>
}

function Signer({ signer, renameAddressCallBack }: { signer: AddressBookEntry, renameAddressCallBack: (entry: AddressBookEntry) => void, }) {
	return <span class = 'log-table' style = 'margin-top: 10px; column-gap: 5px; justify-content: space-between; grid-template-columns: auto auto'>
		<div class = 'log-cell' style = ''>
			<p style = { 'color: var(--subtitle-text-color);' }> Signing address: </p>
		</div>
		<div class = 'log-cell' style = ''>
			<SmallAddress
				addressBookEntry = { signer }
				textColor = { 'var(--subtitle-text-color)' }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
	</span>
}

const HALF_HEADER_HEIGHT = 48 / 2

export function SignatureCard(params: SignatureCardParams) {
	const headerActionLabel = params.collapsed === undefined ? undefined : params.collapsed ? 'Expand signature details' : 'Collapse signature details'
	return <div class = 'card' style = { `top: ${ params.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
		<SignatureHeader { ...params } onHeaderClick = { params.toggleCollapsed } headerActionLabel = { headerActionLabel } ariaExpanded = { params.collapsed === undefined ? undefined : !params.collapsed }/>
		{ params.collapsed === true ? <></> : <div class = 'card-content' style = 'padding-bottom: 5px;'>
			<div class = 'container'>
				<SignRequest { ...params }/>
			</div>
			<QuarantineReasons quarantineReasons = { params.visualizedPersonalSignRequest.quarantineReasons }/>
			<ExtraDetails { ...params }/>
			{ params.visualizedPersonalSignRequest.type === 'NotParsed' ? <></> : <RawMessage { ...params }/> }

			<Signer
				signer = { params.visualizedPersonalSignRequest.activeAddress }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>

			<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
				<div class = 'log-cell'> <TransactionCreated created = { params.visualizedPersonalSignRequest.created } /> </div>
				<div class = 'log-cell' style = 'justify-content: right;'></div>
			</span>
		</div> }
	</div>
}

export function isPossibleToSignMessage(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
	return !(visualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || visualizedPersonalSignRequest.method !== 'personal_sign'))
}

export function InvalidMessage({ pendingTransactionOrSignableMessage } : { pendingTransactionOrSignableMessage: ReadonlySignal<PendingTransactionOrSignableMessage | undefined> }) {
	const current = pendingTransactionOrSignableMessage.value
	if (current?.type !== 'SignableMessage') return <></>
	if (current.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	if (current.visualizedPersonalSignRequest.isValidMessage !== false) return <></>
	return <ErrorComponent warning = { true } text = { 'The requested message format is invalid and cannot be signed.' }/>
}
