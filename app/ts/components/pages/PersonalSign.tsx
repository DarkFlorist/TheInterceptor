import { useState } from 'preact/hooks'
import { dataStringWith0xStart, isHexEncodedNumber, stringToUint8Array } from '../../utils/bigint.js'
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

type SignatureCardParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
	removeTransactionOrSignedMessage: ((transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void) | undefined
	numberOfUnderTransactions: number,
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
			title: 'Arbitary Gnosis Safe message',
			rejectAction: 'Reject Gnosis Safe message',
			simulationAction: 'Simulate Gnosis Safe message',
			signingAction: 'Sign Gnosis Safe message',
		}
		case 'EIP712': {
			const name = data.message.domain.name?.type === 'string' ? `${ data.message.domain.name.value } - ${ data.message.primaryType }` : 'Arbitary EIP712 message'
			return {
				title: `${ name } signing request`,
				rejectAction: `Reject ${ name }`,
				simulationAction: `Simulate ${ name }`,
				signingAction: `Sign ${ name }`,
			}
		}
		case 'NotParsed': return {
			title: 'Arbitary Ethereum message',
			rejectAction: 'Reject arbitary message',
			simulationAction: 'Simulate arbitary message',
			signingAction: 'Sign arbitary message',
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
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { () => removeSignedMessage({ type: 'SignedMessage', messageIdentifier: params.visualizedPersonalSignRequest.messageIdentifier }) }>
				<span class = 'icon' style = 'color: var(--text-color);'> X </span>
			</button>
			: <></>
		}
	</header>
}

type SignRequestParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

const decodeMessage = (message: string) => {
	if (isHexEncodedNumber(message)) return new TextDecoder().decode(stringToUint8Array(message))
	return message
}

function SignRequest({ visualizedPersonalSignRequest, renameAddressCallBack }: SignRequestParams) {
	switch (visualizedPersonalSignRequest.type) {
		case 'NotParsed': {
			if (visualizedPersonalSignRequest.method === 'personal_sign') {
				return <>
					<p class = 'paragraph'>Raw message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ visualizedPersonalSignRequest.message }</p>
					</div>
					<p class = 'paragraph'>Text decoded message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ decodeMessage(visualizedPersonalSignRequest.message) }</p>
					</div>
				</>
			}
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ visualizedPersonalSignRequest.message }</p>
			</div>
		}
		
		case 'SafeTx': return <SafeTx
			visualizedPersonalSignRequestSafeTx = { visualizedPersonalSignRequest }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'EIP712': {
			return <ArbitaryEIP712 enrichedEIP712 = { visualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack } />
		}
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { visualizedPersonalSignRequest.message }
				rpcNetwork = { visualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit': {
			if (visualizedPersonalSignRequest.verifyingContract.type !== 'ERC20') throw new Error('Malformed sign request')
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
			if (visualizedPersonalSignRequest.token.type !== 'ERC20') throw new Error('Malformed sign request')
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

function SafeTx({ visualizedPersonalSignRequestSafeTx, renameAddressCallBack }: { visualizedPersonalSignRequestSafeTx: VisualizedPersonalSignRequestSafeTx, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			{ visualizedPersonalSignRequestSafeTx.message.domain.chainId !== undefined
				? <>
					<CellElement text = 'Chain: '/>
					<CellElement text = { getChainName(BigInt(visualizedPersonalSignRequestSafeTx.message.domain.chainId)) }/>
				</>
				: <></>
			}
			<CellElement text = 'baseGas: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.baseGas }/>
			<CellElement text = 'gasPrice: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.gasPrice }/>
			{ visualizedPersonalSignRequestSafeTx.message.message.gasToken !== 0n
				? <>
					<CellElement text = 'gasToken: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'nonce: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.nonce }/>
			<CellElement text = 'operation: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.operation }/>
			{ visualizedPersonalSignRequestSafeTx.message.message.refundReceiver !== 0n ?
				<>
					<CellElement text = 'refundReceiver: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'safeTxGas: '/>
			<CellElement text = { visualizedPersonalSignRequestSafeTx.message.message.safeTxGas }/>
			<CellElement text = 'to: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { visualizedPersonalSignRequestSafeTx.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'value: '/>
			<CellElement text = { <Ether amount = { visualizedPersonalSignRequestSafeTx.message.message.value } rpcNetwork = { visualizedPersonalSignRequestSafeTx.rpcNetwork } fontSize = 'normal'/>  }/>
		</span>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw transaction input: </p>
		<div class = 'textbox'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(visualizedPersonalSignRequestSafeTx.message.message.data) }</p>
		</div>
	</>
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

type ArbitaryEIP712Params = {
	enrichedEIP712: EnrichedEIP712
	renameAddressCallBack: RenameAddressCallBack
}

function ArbitaryEIP712({ enrichedEIP712, renameAddressCallBack }: ArbitaryEIP712Params) {
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
		<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(permit2.message.message.sigDeadline) * 1000) } countBackwards = { true }/> }/>
		<CellElement text = 'Spender can spend for:'/>
		<CellElement text = { <>
			<SomeTimeAgo priorTimestamp = { new Date(Number(permit2.message.message.details.expiration) * 1000) } countBackwards = { true }/>
			{ ` (until ${ humanReadableDateFromSeconds(permit2.message.message.details.expiration) })` }
		</> }/>
	</>
}

function PermitExtraDetails({ permit }: { permit: VisualizedPersonalSignRequestPermit }) {
	return <>
		<CellElement text = 'Chain: '/>
		<CellElement text = { getChainName(BigInt(permit.message.domain.chainId)) }/>
		<CellElement text = 'Nonce: '/>
		<CellElement text = { permit.message.message.nonce.toString(10) }/>
		<CellElement text = 'Signature expires in:'/>
		<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(permit.message.message.deadline) * 1000) } countBackwards = { true }/> }/>		
	</>
}

type ExtraDetailsCardParams = {
	visualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

function ExtraDetails({ visualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)
	if (visualizedPersonalSignRequest.type !== 'Permit2'
		&& visualizedPersonalSignRequest.type !== 'Permit'
		&& visualizedPersonalSignRequest.type !== 'OrderComponents') {
		return <></>
	}

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Extra details
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <>
				<div class = 'card-content'>
					<div class = 'container' style = 'margin-bottom: 10px;'>
						<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
							{ visualizedPersonalSignRequest.type !== 'Permit2' ? <></> : <Permit2ExtraDetails permit2 = { visualizedPersonalSignRequest }/> }
							{ visualizedPersonalSignRequest.type !== 'Permit' ? <></> : <PermitExtraDetails permit = { visualizedPersonalSignRequest }/> }
							{ visualizedPersonalSignRequest.type !== 'OrderComponents' ? <></> : <OrderComponentsExtraDetails orderComponents = { visualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack }/> }
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
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <>
				<div class = 'card-content'>
					<div class = 'container' style = 'margin-bottom: 10px;'>
						<div class = 'textbox'>
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ visualizedPersonalSignRequest.rawMessage }</p>
						</div>
					</div>
				</div>
			</>
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
			<RawMessage { ...params }/>
			
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
