import { useState } from 'preact/hooks'
import { bigintSecondsToDate, isHexEncodedNumber, stringToUint8Array } from '../../utils/bigint.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import { assertNever } from '../../utils/typescript.js'
import { SimpleTokenApprovalVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { VisualizedPersonalSignRequest, VisualizedPersonalSignRequestPermit, VisualizedPersonalSignRequestPermit2, VisualizedPersonalSignRequestSafeTx } from '../../types/personal-message-definitions.js'
import { OrderComponents, OrderComponentsExtraDetails } from '../simulationExplaining/customExplainers/OpenSeaOrder.js'
import { Ether } from '../subcomponents/coins.js'
import { humanReadableDateFromSeconds, CellElement } from '../ui-utils.js'
import { AddressBookEntry } from '../../types/addressBookTypes.js'
import { EnrichedEIP712, EnrichedEIP712Message, TypeEnrichedEIP712MessageRecord } from '../../types/eip721.js'
import { TransactionCreated } from '../simulationExplaining/SimulationSummary.js'
import { EnrichedSolidityTypeComponent } from '../subcomponents/solidityType.js'
import { QuarantineReasons } from '../simulationExplaining/Transactions.js'
import { GnosisSafeVisualizer } from '../simulationExplaining/customExplainers/GnosisSafeVisualizer.js'
import { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { ViewSelector, ViewSelector as Viewer } from '../subcomponents/ViewSelector.js'
import { ChevronIcon, XMarkIcon } from '../subcomponents/icons.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'

type SignatureCardParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
	removeTransactionOrSignedMessage: ((transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void) | undefined
	numberOfUnderTransactions: number
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

type SignatureHeaderParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	removeTransactionOrSignedMessage?: ((transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void) | undefined
}

export function identifySignature(data: VisualizedPersonalSignRequest) {
	switch (data.type) {
		case 'OrderComponents': return {
			title: 'Opensea order',
			rejectAction: 'Reject Opensea order',
			simulationAction: 'Simulate Opensea order',
			signingAction: 'Sign Opensea order',
		}
		case 'SafeTx': return {
			title: 'Gnosis Safe message',
			rejectAction: 'Reject Gnosis Safe message',
			simulationAction: 'Simulate Gnosis Safe message',
			signingAction: 'Sign Gnosis Safe message',
		}
		case 'EIP712': {
			const name = data.message.domain.name?.type === 'string' ? `${ data.message.domain.name.value } - ${ data.message.primaryType }` : 'Arbitrary EIP712 message'
			return {
				title: `${ name } signing request`,
				rejectAction: `Reject ${ name }`,
				simulationAction: `Simulate ${ name }`,
				signingAction: `Sign ${ name }`,
			}
		}
		case 'NotParsed': return {
			title: 'Arbitrary Ethereum message',
			rejectAction: 'Reject arbitrary message',
			simulationAction: 'Simulate arbitrary message',
			signingAction: 'Sign arbitrary message',
		}
		case 'Permit': {
			const symbol = data.verifyingContract
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.spender
			}
		}
		case 'Permit2': {
			const symbol = 'symbol' in data.token ? data.token.symbol : '???'
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.spender
			}
		}
		default: assertNever(data)
	}
}

export function SignatureHeader(params: SignatureHeaderParams) {
	const removeSignedMessage = params.removeTransactionOrSignedMessage
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { params.visualizedPersonalSignRequest.simulationMode ? '../img/head-simulating.png' : '../img/head-signing.png' } />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifySignature(params.visualizedPersonalSignRequest).title }
		</p>
		<p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden; ${ params.removeTransactionOrSignedMessage !== undefined ? 'padding: 0' : ''}` }>
			<WebsiteOriginText { ...params.visualizedPersonalSignRequest.website } />
		</p>
		{ removeSignedMessage !== undefined
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { () => removeSignedMessage({ type: 'Message', messageIdentifier: params.visualizedPersonalSignRequest.messageIdentifier }) }>
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

const decodeMessage = (message: string) => {
	if (isHexEncodedNumber(message)) return new TextDecoder().decode(stringToUint8Array(message))
	return message
}

function isNinetyFivePercentNumbersOrASCII(input: string): boolean {
	const asciiCount = input.split('').filter(char => char.charCodeAt(0) <= 127).length
	const numberCount = input.split('').filter(char => !isNaN(Number(char))).length
	const validCount = asciiCount + numberCount
	return validCount / input.length >= 0.95
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
		case 'EIP712': {
			return <ArbitraryEIP712 enrichedEIP712 = { visualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack } />
		}
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { visualizedPersonalSignRequest.message }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit': {
			if (visualizedPersonalSignRequest.verifyingContract.type !== 'ERC20') return <ErrorComponent text = { 'Malformed Permit1 request. The tokentype is not ERC20' }/>
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'ERC20',
					from: visualizedPersonalSignRequest.account,
					to: visualizedPersonalSignRequest.spender,
					token: visualizedPersonalSignRequest.verifyingContract,
					amount: visualizedPersonalSignRequest.message.message.value,
					isApproval: true,
					logObject: undefined,
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit2': {
			if (visualizedPersonalSignRequest.token.type !== 'ERC20') return <ErrorComponent text = { 'Malformed Permit2 request. The tokentype is not ERC20' }/>
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'ERC20',
					token: visualizedPersonalSignRequest.token,
					amount: visualizedPersonalSignRequest.message.message.details.amount,
					from: visualizedPersonalSignRequest.account,
					to: visualizedPersonalSignRequest.spender,
					isApproval: true,
					logObject: undefined,
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
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
	function EIP712Entry({ name, entry }: EIP712Entry) {
		if (entry === undefined) return <></>
		if (entry.type === 'record[]') {
			return <>
				<CellElement text = { `${ name }: ` }/>
				<CellElement text = { entry.value.map((value) => <EIP712Table enrichedEIP712Message = { value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>) } />
			</>
		}
		if (entry.type === 'record') {
			return <>
				<CellElement text = { `${ name }: ` }/>
				<CellElement text = { <EIP712Table enrichedEIP712Message = { entry.value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/> }/>
			</>
		}
		return <>
			<CellElement text = { `${ name }: ` }/>
			<CellElement text = { <EnrichedSolidityTypeComponent valueType = { entry } renameAddressCallBack = { renameAddressCallBack }/> }/>
		</>
	}
	return <span class = 'eip-712-table' style = { isSubTable ? 'justify-content: space-between;' : '' }>
		{ Object.entries(enrichedEIP712Message).map(([name, entry]) => <EIP712Entry entry = { entry } name = { name }/>) }
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

function Permit2ExtraDetails({ permit2 }: { permit2: VisualizedPersonalSignRequestPermit2 }) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(BigInt(permit2.message.domain.chainId)) }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit2.message.message.details.nonce.toString(10) }/>
		<CellElement text = 'Signature expires  in:'/>
		<CellElement text = { <SomeTimeAgo priorTimestamp = { bigintSecondsToDate(permit2.message.message.sigDeadline) } countBackwards = { true }/> }/>
		<CellElement text = 'Spender can spend for:'/>
		<CellElement text = { <>
			<SomeTimeAgo priorTimestamp = { bigintSecondsToDate(permit2.message.message.details.expiration) } countBackwards = { true }/>
			{ ` (until ${ humanReadableDateFromSeconds(permit2.message.message.details.expiration) })` }
		</> }/>
		<CellElement text = 'Domain Hash: '/>
		<CellElement text = { permit2.domainHash }/>
		<CellElement text = 'Message Hash: '/>
		<CellElement text = { permit2.messageHash }/>
	</>
}

function PermitExtraDetails({ permit }: { permit: VisualizedPersonalSignRequestPermit }) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(BigInt(permit.message.domain.chainId)) }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit.message.message.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in:'/>
		<CellElement text = { <SomeTimeAgo priorTimestamp = { bigintSecondsToDate(BigInt(permit.message.message.deadline)) } countBackwards = { true }/> }/>
		<CellElement text = 'Domain Hash: '/>
		<CellElement text = { permit.domainHash }/>
		<CellElement text = 'Message Hash: '/>
		<CellElement text = { permit.messageHash }/>
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
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			{ visualizedPersonalSignRequestSafeTx.message.domain.chainId !== undefined
				? <>
					<CellElement text = 'Chain: '/>
					<CellElement text = { getChainName(BigInt(visualizedPersonalSignRequestSafeTx.message.domain.chainId)) }/>
				</>
				: <></>
			}
			<CellElement text = 'Base Gas: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.baseGas }/>
			<CellElement text = 'Gas Price: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.gasPrice }/>
			{ visualizedPersonalSignRequestSafeTx.message.message.gasToken !== 0n
				? <>
					<CellElement text = 'Gas Token: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'Nonce: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.nonce }/>
			<CellElement text = 'Operation: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.operation }/>
			{ visualizedPersonalSignRequestSafeTx.message.message.refundReceiver !== 0n ?
				<>
					<CellElement text = 'Refund Receiver: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'Safe Transaction Gas: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.safeTxGas }/>
			<CellElement text = 'To: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'Value: '/>
			<CellElement text = { <Ether amount = { visualizedPersonalSignRequestSafeTx.message.message.value } rpcNetwork = { visualizedPersonalSignRequestSafeTx.rpcNetwork } fontSize = 'normal'/> }/>
			<CellElement text = 'Domain Hash: '/>
			<code><CellElement text = { visualizedPersonalSignRequestSafeTx.domainHash }/></code>
			<CellElement text = 'Message Hash: '/>
			<code><CellElement text = { visualizedPersonalSignRequestSafeTx.messageHash }/></code>
			<CellElement text = 'Safe Transaction Hash: '/>
			<code><CellElement text = { visualizedPersonalSignRequestSafeTx.safeTxHash }/></code>
		</span>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Gnosis Safe meta transaction input: </p>
		<TransactionInput parsedInputData = { visualizedPersonalSignRequestSafeTx.parsedMessageData } to = { visualizedPersonalSignRequestSafeTx.to } input = { visualizedPersonalSignRequestSafeTx.parsedMessageData.input } addressMetaData = { visualizedPersonalSignRequestSafeTx.parsedMessageDataAddressBookEntries } renameAddressCallBack = { renameAddressCallBack }/>
	</>
}


function ExtraDetailsInner({ visualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	switch(visualizedPersonalSignRequest.type) {
		case 'EIP712':
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
		case 'Permit': return <PermitExtraDetails permit = { visualizedPersonalSignRequest }/>
		case 'Permit2': return <Permit2ExtraDetails permit2 = { visualizedPersonalSignRequest }/>
		case 'SafeTx': return <GnosisSafeExtraDetails visualizedPersonalSignRequestSafeTx = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
		default: assertNever(visualizedPersonalSignRequest)
	}
}


function ExtraDetails({ visualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Extra details
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <>
				<div class = 'card-content'>
					<div class = 'container' style = 'margin-bottom: 10px;'>
						<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
							<ExtraDetailsInner visualizedPersonalSignRequest = { visualizedPersonalSignRequest } renameAddressCallBack = { renameAddressCallBack }/>
						</span>
					</div>
				</div>
			</>
		}
	</div>
}

function RawMessage({ visualizedPersonalSignRequest }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)
	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Raw message
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <ViewSelector id = 'raw_message'>
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
		}
	</div>
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
	return <div class = 'card' style = { `top: ${ params.numberOfUnderTransactions * -HALF_HEADER_HEIGHT }px` }>
		<SignatureHeader { ...params }/>
		<div class = 'card-content' style = 'padding-bottom: 5px;'>
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
		</div>
	</div>
}

export function isPossibleToSignMessage(visualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
	return !(visualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || visualizedPersonalSignRequest.method !== 'personal_sign'))
}

export function InvalidMessage({ pendingTransactionOrSignableMessage } : { pendingTransactionOrSignableMessage: PendingTransactionOrSignableMessage }) {
	if (pendingTransactionOrSignableMessage.type !== 'SignableMessage') return <></>
	if (pendingTransactionOrSignableMessage.transactionOrMessageCreationStatus !== 'Simulated') return <></>
	if (pendingTransactionOrSignableMessage.visualizedPersonalSignRequest.isValidMessage !== false) return <></>
	return <ErrorComponent warning = { true } text = { 'The requested message format is invalid and cannot be signed.' }/>
}
