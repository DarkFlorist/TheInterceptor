import { useState, useEffect } from 'preact/hooks'
import { checksummedAddress, dataStringWith0xStart, stringToUint8Array } from '../../utils/bigint.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { ErrorCheckBox, Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { ExternalPopupMessage, PartiallyParsedRefreshPersonalSignMetadata, PersonalSignRequest, RefreshPersonalSignMetadata } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { assertNever } from '../../utils/typescript.js'
import { SimpleTokenApprovalVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { CenterToPageTextSpinner } from '../subcomponents/Spinner.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { QuarantineCodes } from '../simulationExplaining/Transactions.js'
import { VisualizedPersonalSignRequest, VisualizedPersonalSignRequestPermit, VisualizedPersonalSignRequestPermit2, VisualizedPersonalSignRequestSafeTx } from '../../types/personal-message-definitions.js'
import { OrderComponents, OrderComponentsExtraDetails } from '../simulationExplaining/customExplainers/OpenSeaOrder.js'
import { Ether } from '../subcomponents/coins.js'
import { tryFocusingTabOrWindow, humanReadableDateFromSeconds, CellElement } from '../ui-utils.js'
import { AddressBookEntry, IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import { EnrichedEIP712, EnrichedEIP712Message, GroupedSolidityType } from '../../types/eip721.js'
import { serialize } from '../../types/wire-types.js'
import { TransactionCreated } from '../simulationExplaining/SimulationSummary.js'

type SignatureCardParams = {
	VisualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

type SignatureHeaderParams = {
	VisualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
	removeSignature?: () => void,
}

function identifySignature(data: VisualizedPersonalSignRequest) {
	switch (data.type) {
		case 'OrderComponents': return {
			title: 'Opensea order',
			rejectAction: 'Reject Opensea order',
			simulationAction: 'Simulate Opensea order',
			signingAction: 'Sign Opensea order',
		}
		case 'SafeTx': return {
			title: 'Arbitary Gnosis Safe message signing request',
			rejectAction: 'Reject Gnosis Safe message',
			simulationAction: 'Simulate Gnosis Safe message',
			signingAction: 'Sign Gnosis Safe message',
		}
		case 'EIP712': {
			const name = data.message.domain.name?.type === 'string' ? data.message.domain.name.value : 'Arbitary EIP712 message'
			return {
				title: `${ name } signing request`,
				rejectAction: `Reject ${ name }`,
				simulationAction: `Simulate ${ name }`,
				signingAction: `Sign ${ name }`,
			}
		}
		case 'NotParsed': return {
			title: 'Arbitary Ethereum message signing request',
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

function SignatureHeader(params: SignatureHeaderParams) {
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { params.VisualizedPersonalSignRequest.simulationMode ? '../img/head-simulating.png' : '../img/head-signing.png' } />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifySignature(params.VisualizedPersonalSignRequest).title }
		</p>
		<p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden; ${ params.removeSignature !== undefined ? 'padding: 0' : ''}` }>
			<WebsiteOriginText { ...params.VisualizedPersonalSignRequest.website } />
		</p>
		{ params.removeSignature !== undefined
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { params.removeSignature }>
				<span class = 'icon' style = 'color: var(--text-color);'> X </span>
			</button>
			: <></>
		}
	</header>
}

type SignRequestParams = {
	VisualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

function SignRequest({ VisualizedPersonalSignRequest, renameAddressCallBack }: SignRequestParams) {
	switch (VisualizedPersonalSignRequest.type) {
		case 'NotParsed': {
			if (VisualizedPersonalSignRequest.method === 'personal_sign') {
				return <>
					<p class = 'paragraph'>Raw message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ VisualizedPersonalSignRequest.message }</p>
					</div>
					<p class = 'paragraph'>Text decoded message: </p>
					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ new TextDecoder().decode(stringToUint8Array(VisualizedPersonalSignRequest.message)) }</p>
					</div>
				</>
			}
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ VisualizedPersonalSignRequest.message }</p>
			</div>
		}
		
		case 'SafeTx': return <SafeTx
			VisualizedPersonalSignRequestSafeTx = { VisualizedPersonalSignRequest }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'EIP712': {
			return <ArbitaryEIP712 enrichedEIP712 = { VisualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack } />
		}
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { VisualizedPersonalSignRequest.message }
				rpcNetwork = { VisualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit': {
			if (VisualizedPersonalSignRequest.verifyingContract.type !== 'ERC20') throw new Error('Malformed sign request')
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'ERC20',
					from: VisualizedPersonalSignRequest.account,
					to: VisualizedPersonalSignRequest.spender,
					token: VisualizedPersonalSignRequest.verifyingContract,
					amount: VisualizedPersonalSignRequest.message.message.value,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { VisualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit2': {
			if (VisualizedPersonalSignRequest.token.type !== 'ERC20') throw new Error('Malformed sign request')
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'ERC20',
					token: VisualizedPersonalSignRequest.token,
					amount: VisualizedPersonalSignRequest.message.message.details.amount,
					from: VisualizedPersonalSignRequest.account,
					to: VisualizedPersonalSignRequest.spender,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				rpcNetwork = { VisualizedPersonalSignRequest.rpcNetwork }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		default: assertNever(VisualizedPersonalSignRequest)
	}
}

function SafeTx({ VisualizedPersonalSignRequestSafeTx, renameAddressCallBack }: { VisualizedPersonalSignRequestSafeTx: VisualizedPersonalSignRequestSafeTx, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			{ VisualizedPersonalSignRequestSafeTx.message.domain.chainId !== undefined
				? <>
					<CellElement text = 'Chain: '/>
					<CellElement text = { getChainName(BigInt(VisualizedPersonalSignRequestSafeTx.message.domain.chainId)) }/>
				</>
				: <></>
			}
			<CellElement text = 'baseGas: '/>
			<CellElement text = { VisualizedPersonalSignRequestSafeTx.message.message.baseGas }/>
			<CellElement text = 'gasPrice: '/>
			<CellElement text = { VisualizedPersonalSignRequestSafeTx.message.message.gasPrice }/>
			{ VisualizedPersonalSignRequestSafeTx.message.message.gasToken !== 0n
				? <>
					<CellElement text = 'gasToken: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { VisualizedPersonalSignRequestSafeTx.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'nonce: '/>
			<CellElement text = { VisualizedPersonalSignRequestSafeTx.message.message.nonce }/>
			<CellElement text = 'operation: '/>
			<CellElement text = { VisualizedPersonalSignRequestSafeTx.message.message.operation }/>
			{ VisualizedPersonalSignRequestSafeTx.message.message.refundReceiver !== 0n ?
				<>
					<CellElement text = 'refundReceiver: '/>
					<CellElement text = { <SmallAddress addressBookEntry = { VisualizedPersonalSignRequestSafeTx.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
				</>
				: <></>
			}
			<CellElement text = 'safeTxGas: '/>
			<CellElement text = { VisualizedPersonalSignRequestSafeTx.message.message.safeTxGas }/>
			<CellElement text = 'to: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { VisualizedPersonalSignRequestSafeTx.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'value: '/>
			<CellElement text = { <Ether amount = { VisualizedPersonalSignRequestSafeTx.message.message.value } rpcNetwork = { VisualizedPersonalSignRequestSafeTx.rpcNetwork } fontSize = { 'normal' }/>  }/>
		</span>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw transaction input: </p>
		<div class = 'textbox'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(VisualizedPersonalSignRequestSafeTx.message.message.data) }</p>
		</div>
	</>
}

function visualizeEIP712Component(valueType: GroupedSolidityType, renameAddressCallBack: RenameAddressCallBack) {
	switch(valueType.type) {
		case 'address': return <SmallAddress addressBookEntry = { valueType.value } renameAddressCallBack = { renameAddressCallBack } />
		case 'bool': return valueType.value
		case 'bytes': return <div class = 'textbox' style = 'white-space: normal;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(valueType.value) }</p> </div>
		case 'fixedBytes': return dataStringWith0xStart(valueType.value)
		case 'integer': return valueType.value
		case 'string': return valueType.value
		case 'address[]': return valueType.value.map((value) => <SmallAddress addressBookEntry = { value } renameAddressCallBack = { renameAddressCallBack } />)
		case 'bool[]': return `[ ${valueType.value.toString() }]`
		case 'bytes[]':  return valueType.value.map((value) => <div class = 'textbox' style = 'white-space: normal;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(value) }</p> </div>)
		case 'fixedBytes[]': return `[ ${valueType.value.toString() }]`
		case 'integer[]': return `[ ${valueType.value.toString() }]`
		case 'string[]': return `[ ${valueType.value.toString() }]`
		default: assertNever(valueType)
	}
}
type EIP712Table = {
	enrichedEIP712Message: EnrichedEIP712Message
	renameAddressCallBack: RenameAddressCallBack
	isSubTable: boolean
}

function EIP712Table({ enrichedEIP712Message, renameAddressCallBack, isSubTable }: EIP712Table) {
	return <span class = 'eip-712-table' style = { isSubTable ? 'justify-content: space-between;' : '' }>
		<>{ Object.entries(enrichedEIP712Message).map(([key, entry]) => <>
			{ entry === undefined
				? <></>
				: <>
					<CellElement text = { `${ key }: ` }/>
					{ entry.type === 'record' || entry.type === 'record[]' ?
						entry.type === 'record[]' ?
							<CellElement text = { entry.value.map((value) => <EIP712Table enrichedEIP712Message = { value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>) } />
							: <CellElement text = { <EIP712Table enrichedEIP712Message = { entry.value } renameAddressCallBack = { renameAddressCallBack } isSubTable = { true }/>
						} />
						: <CellElement text = { visualizeEIP712Component(entry, renameAddressCallBack) }/>
					}
				</>
			}
		</>) } </>
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

export function Permit2ExtraDetails({ permit2 }: { permit2: VisualizedPersonalSignRequestPermit2 }) {
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
			{` (until ${ humanReadableDateFromSeconds(permit2.message.message.details.expiration) })`}
		</> }/>
	</>
}

export function PermitExtraDetails({ permit }: { permit: VisualizedPersonalSignRequestPermit }) {
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
	VisualizedPersonalSignRequest: VisualizedPersonalSignRequest
	renameAddressCallBack: RenameAddressCallBack
}

export function ExtraDetails({ VisualizedPersonalSignRequest, renameAddressCallBack }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)
	if (VisualizedPersonalSignRequest.type !== 'Permit2'
		&& VisualizedPersonalSignRequest.type !== 'Permit'
		&& VisualizedPersonalSignRequest.type !== 'OrderComponents') {
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
							{ VisualizedPersonalSignRequest.type !== 'Permit2' ? <></> : <Permit2ExtraDetails permit2 = { VisualizedPersonalSignRequest }/> }
							{ VisualizedPersonalSignRequest.type !== 'Permit' ? <></> : <PermitExtraDetails permit = { VisualizedPersonalSignRequest }/> }
							{ VisualizedPersonalSignRequest.type !== 'OrderComponents' ? <></> : <OrderComponentsExtraDetails orderComponents = { VisualizedPersonalSignRequest.message } renameAddressCallBack = { renameAddressCallBack }/> }
						</span>
					</div>
				</div>
			</>
		}
	</div>
}

export function RawMessage({ VisualizedPersonalSignRequest }: ExtraDetailsCardParams) {
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
							<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ VisualizedPersonalSignRequest.rawMessage }</p>
						</div>
					</div>
				</div>
			</>
		}
	</div>
}

export function Signer({ signer, renameAddressCallBack }: { signer: AddressBookEntry, renameAddressCallBack: (entry: AddressBookEntry) => void, }) {
	return <span class = 'log-table' style = 'margin-top: 10px; column-gap: 5px; justify-content: space-between; grid-template-columns: auto auto'>
		<div class = 'log-cell' style = ''>
			<p style = { `color: var(--subtitle-text-color);` }> Signed by: </p>
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

export function SignatureCard(params: SignatureCardParams) {
	return <>
		<div class = 'card'>
			<SignatureHeader { ...params }/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<SignRequest { ...params }/>
					<QuarantineCodes quarantineCodes = { params.VisualizedPersonalSignRequest.quarantineCodes }/>
				</div>
				<ExtraDetails { ...params }/>
				<RawMessage { ...params }/>
				
				<Signer
					signer = { params.VisualizedPersonalSignRequest.activeAddress }
					renameAddressCallBack = { params.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: auto auto;'>
					<div class = 'log-cell'> <TransactionCreated created = { params.VisualizedPersonalSignRequest.created } /> </div>
					<div class = 'log-cell' style = 'justify-content: right;'></div>
				</span>
			</div>
		</div>
	</>
}

export function PersonalSign() {
	const [addingNewAddress, setAddingNewAddress] = useState<IncompleteAddressBookEntry | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [VisualizedPersonalSignRequest, setVisualizedPersonalSignRequest] = useState<VisualizedPersonalSignRequest | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)

	useEffect(() => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_personal_sign_request') return
			setVisualizedPersonalSignRequest(PersonalSignRequest.parse(message).data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_personalSignReadyAndListening' }) }, [])

	function refreshMetadata() {
		if (VisualizedPersonalSignRequest === undefined) return
		sendPopupMessageToBackgroundPage(serialize(RefreshPersonalSignMetadata, { method: 'popup_refreshPersonalSignMetadata' as const, data: VisualizedPersonalSignRequest }) as PartiallyParsedRefreshPersonalSignMetadata)
	}

	async function approve() {
		if (VisualizedPersonalSignRequest === undefined) throw new Error('VisualizedPersonalSignRequest is missing')
		await tryFocusingTabOrWindow({ type: 'tab', id: VisualizedPersonalSignRequest.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSignApproval', data: { uniqueRequestIdentifier: VisualizedPersonalSignRequest.request.uniqueRequestIdentifier, accept: true } })
	}

	async function reject() {
		if (VisualizedPersonalSignRequest === undefined) throw new Error('VisualizedPersonalSignRequest is missing')
		await tryFocusingTabOrWindow({ type: 'tab', id: VisualizedPersonalSignRequest.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSignApproval', data: { uniqueRequestIdentifier: VisualizedPersonalSignRequest.request.uniqueRequestIdentifier, accept: false } })
	}

	function isPossibleToSend(VisualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
		return !(VisualizedPersonalSignRequest.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || VisualizedPersonalSignRequest.method !== 'personal_sign'))
	}

	function isConfirmDisabled(VisualizedPersonalSignRequest: VisualizedPersonalSignRequest, activeAddress: bigint) {
		return !isPossibleToSend(VisualizedPersonalSignRequest, activeAddress) && !forceSend
			&& !(VisualizedPersonalSignRequest.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/birdchalkrenewtip' // todo remove this check
			|| VisualizedPersonalSignRequest.rpcNetwork.httpsRpc === 'https://rpc.dark.florist/winedancemuffinborrow')
	}
	
	function Buttons() {
		if (VisualizedPersonalSignRequest === undefined) return <></>
		const identified = identifySignature(VisualizedPersonalSignRequest)
	
		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { reject } >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right'
				onClick = { approve }
				disabled = { isConfirmDisabled(VisualizedPersonalSignRequest, VisualizedPersonalSignRequest.activeAddress.address) }>
				{ VisualizedPersonalSignRequest.simulationMode
					? `${ identified.simulationAction }!`
					: <SignerLogoText { ...{ signerName: VisualizedPersonalSignRequest.signerName, text: identified.signingAction, } }/>
				}
			</button>
		</div>
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({
			addingAddress: false,
			askForAddressAccess: false,
			symbol: undefined,
			decimals: undefined,
			logoUri: undefined,
			...entry,
			address: checksummedAddress(entry.address)
		})
	}

	if (VisualizedPersonalSignRequest === undefined) return <CenterToPageTextSpinner text = 'Visualizing...'/>
	
	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed'
						? <></>
						: <AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							incompleteAddressBookEntry = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
					<div style = 'overflow-y: auto'>
						<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
							<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden;'>
								<WebsiteOriginText { ...VisualizedPersonalSignRequest.website } />
							</div>
							<p class = 'card-header-title' style = 'overflow: hidden; font-weight: unset; flex-direction: row-reverse;'>
								{ VisualizedPersonalSignRequest.activeAddress === undefined ? <></> : <SmallAddress
									addressBookEntry = { VisualizedPersonalSignRequest.activeAddress }
									renameAddressCallBack = { renameAddressCallBack }
								/> }
							</p>
						</header>
						<div style = 'margin: 10px;'>
							<SignatureCard
								VisualizedPersonalSignRequest = { VisualizedPersonalSignRequest }
								renameAddressCallBack = { renameAddressCallBack }
							/>
						</div>
					</div>

					<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
						
						{ isPossibleToSend(VisualizedPersonalSignRequest, VisualizedPersonalSignRequest.activeAddress.address) && VisualizedPersonalSignRequest.quarantine
							? <div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
							: <></>
						}
						{ VisualizedPersonalSignRequest.simulationMode && (VisualizedPersonalSignRequest.activeAddress.address === undefined || VisualizedPersonalSignRequest.activeAddress.address !== MOCK_PRIVATE_KEYS_ADDRESS || VisualizedPersonalSignRequest.method != 'personal_sign')
							? <div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorComponent text = 'Unfortunately we cannot simulate message signing as it requires private key access 😢.'/>
								</div>
							</div>
							: <></>
						}
						<Buttons/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
