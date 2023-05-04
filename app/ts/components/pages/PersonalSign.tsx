import { useState, useEffect } from 'preact/hooks'
import { dataStringWith0xStart, stringToUint8Array, stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { AddingNewAddressType, AddressBookEntry, RenameAddressCallBack, SignerName } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { ErrorCheckBox, Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { ExternalPopupMessage } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { assertNever } from '../../utils/typescript.js'
import { SimpleTokenApprovalVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { Spinner } from '../subcomponents/Spinner.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { QuarantineCodes } from '../simulationExplaining/Transactions.js'
import { ComponentChildren } from 'preact'
import { isSupportedChain } from '../../utils/constants.js'
import { PersonalSignRequestData, PersonalSignRequestDataPermit, PersonalSignRequestDataPermit2, PersonalSignRequestDataSafeTx } from '../../utils/personal-message-definitions.js'
import { OrderComponents, OrderComponentsExtraDetails } from '../simulationExplaining/customExplainers/OpenSeaOrder.js'
import { Ether } from '../subcomponents/coins.js'

type SignatureCardParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

type SignatureHeaderParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

function identifySignature(data: PersonalSignRequestData) {
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
		case 'EIP712': return {
			title: 'Arbitary EIP712 message signing request',
			rejectAction: 'Reject EIP712 message',
			simulationAction: 'Simulate EIP712 message',
			signingAction: 'Sign EIP712 message',
		}
		case 'NotParsed': return {
			title: 'Arbitary Ethereum message signing request',
			rejectAction: 'Reject arbitary message',
			simulationAction: 'Simulate arbitary message',
			signingAction: 'Sign arbitary message',
		}
		case 'Permit': {
			const symbol = data.addressBookEntries.verifyingContract
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.addressBookEntries.spender
			}
		}
		case 'Permit2': {
			const symbol = data.addressBookEntries.token.symbol
			return {
				title: `${ symbol } Permit`,
				signingAction: `Sign ${ symbol } Permit`,
				simulationAction: `Simulate ${ symbol } Permit`,
				rejectAction: `Reject ${ symbol } Permit`,
				to: data.addressBookEntries.spender
			}
		}
		default: assertNever(data)
	}
}

function SignatureHeader(params: SignatureHeaderParams) {
	return <header class = 'card-header' style = 'height: 40px;'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { params.personalSignRequestData.simulationMode ? '../img/head-simulating.png' : '../img/head-signing.png' } />
			</span>
		</div>

		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifySignature(params.personalSignRequestData).title }
		</p>
		<p class = 'card-header-icon' style = 'margin-left: auto; margin-right: 0; padding-right: 10px; padding-left: 0px; overflow: hidden'>
			{'addressBookEntries' in params.personalSignRequestData && 'spender' in params.personalSignRequestData.addressBookEntries ?
				<SmallAddress
					addressBookEntry = { params.personalSignRequestData.addressBookEntries.spender }
					renameAddressCallBack = { params.renameAddressCallBack }
					style = { { 'background-color': 'unset' } }
				/>
			: <></>}
		</p>
	</header>
}

type SignRequestParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

function SignRequest({ personalSignRequestData, renameAddressCallBack }: SignRequestParams) {
	switch (personalSignRequestData.type) {
		case 'NotParsed': {
			if (personalSignRequestData.originalParams.method === 'personal_sign') {
				return <div class = 'textbox'>
					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ new TextDecoder().decode(stringToUint8Array(personalSignRequestData.message)) }</p>
				</div>
			}
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ personalSignRequestData.message }</p>
			</div>
		}
		
		case 'SafeTx': return <SafeTx
			personalSignRequestDataSafeTx = { personalSignRequestData }
			renameAddressCallBack = { renameAddressCallBack }
		/>
		case 'EIP712': {
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ stringifyJSONWithBigInts(personalSignRequestData.message, 4) }</p>
			</div>
		}
		case 'OrderComponents': {
			return <OrderComponents
				openSeaOrderMessage = { personalSignRequestData.message }
				chainId = { isSupportedChain(personalSignRequestData.activeChainId) ? personalSignRequestData.activeChainId : '1' }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit': {
			const chainId = personalSignRequestData.message.domain.chainId.toString()
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'Token',
					from: personalSignRequestData.account,
					to: personalSignRequestData.addressBookEntries.spender,
					token: personalSignRequestData.addressBookEntries.verifyingContract,
					amount: personalSignRequestData.message.message.value,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				chainId = { isSupportedChain(chainId) ? chainId : '1' }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		case 'Permit2': {
			const chainId = personalSignRequestData.message.domain.chainId.toString()
			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'Token',
					token: personalSignRequestData.addressBookEntries.token,
					amount: personalSignRequestData.message.message.details.amount,
					from: personalSignRequestData.account,
					to: personalSignRequestData.addressBookEntries.spender,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				chainId = { isSupportedChain(chainId) ? chainId : '1' }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		}
		default: assertNever(personalSignRequestData)
	}
}

function SafeTx({ personalSignRequestDataSafeTx, renameAddressCallBack }: { personalSignRequestDataSafeTx: PersonalSignRequestDataSafeTx, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
			{ personalSignRequestDataSafeTx.message.domain.chainId !== undefined ? <>
				<CellElement text = 'Chain: '/>
				<CellElement text = { getChainName(BigInt(personalSignRequestDataSafeTx.message.domain.chainId)) }/>
			</> : <></>}
			<CellElement text = 'baseGas: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.baseGas }/>
			<CellElement text = 'gasPrice: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.gasPrice }/>
			{ personalSignRequestDataSafeTx.message.message.gasToken !== 0n ? <>
				<CellElement text = 'gasToken: '/>
				<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.gasToken } renameAddressCallBack = { renameAddressCallBack } /> }/>
			</> : <></> }
			<CellElement text = 'nonce: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.nonce }/>
			<CellElement text = 'operation: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.operation }/>
			{ personalSignRequestDataSafeTx.message.message.refundReceiver !== 0n ? <>
				<CellElement text = 'refundReceiver: '/>
				<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.refundReceiver } renameAddressCallBack = { renameAddressCallBack } /> }/>
			</> : <></> }
			<CellElement text = 'safeTxGas: '/>
			<CellElement text = { personalSignRequestDataSafeTx.message.message.safeTxGas }/>
			<CellElement text = 'to: '/>
			<CellElement text = { <SmallAddress addressBookEntry = { personalSignRequestDataSafeTx.addressBookEntries.to } renameAddressCallBack = { renameAddressCallBack } /> }/>
			<CellElement text = 'value: '/>
			<CellElement text = { <Ether amount = { personalSignRequestDataSafeTx.message.message.value } chain = { personalSignRequestDataSafeTx.activeChainId }/>  }/>
		</span>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw transaction input: </p>
		<div class = 'textbox'>
			<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(personalSignRequestDataSafeTx.message.message.data) }</p>
		</div>
	</>
}

const CellElement = (param: { text: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'> { param.text }</p></div>
}

export function Permit2ExtraDetails({ permit2 }: { permit2: PersonalSignRequestDataPermit2 }) {
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
			{` (until ${ new Date(Number(permit2.message.message.details.expiration) * 1000).toISOString().split('T')[0] })`}
		</> }/>
	</>
}

export function PermitExtraDetails({ permit }: { permit: PersonalSignRequestDataPermit }) {
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
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

export function ExtraDetails({ personalSignRequestData, renameAddressCallBack }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(true)

	if (personalSignRequestData.type !== 'Permit2'
		&& personalSignRequestData.type !== 'Permit'
		&& personalSignRequestData.type !== 'OrderComponents') {
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
		{ !showSummary ? <></> : <>
			<div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px;'>
					<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; grid-template-columns: auto auto'>
						{ personalSignRequestData.type !== 'Permit2' ? <></> : <Permit2ExtraDetails permit2 = { personalSignRequestData }/> }
						{ personalSignRequestData.type !== 'Permit' ? <></> : <PermitExtraDetails permit = { personalSignRequestData }/> }
						{ personalSignRequestData.type !== 'OrderComponents' ? <></> : <OrderComponentsExtraDetails orderComponents = { personalSignRequestData.message } renameAddressCallBack = { renameAddressCallBack }/> }
					</span>
				</div>
			</div>
		</> }
	</div>
}

function SignatureCard(params: SignatureCardParams) {
	return <>
		<div class = 'card' style = 'margin: 10px;'>
			<SignatureHeader { ...params }/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<SignRequest { ...params }/>
					<QuarantineCodes quarantineCodes = { params.personalSignRequestData.quarantineCodes }/>
				</div>
				<ExtraDetails { ...params }/>
			</div>
		</div>
	</>
}

type ButtonsParams = {
	signerName: SignerName
	personalSignRequestData: PersonalSignRequestData
	activeAddress: AddressBookEntry
	renameAddressCallBack: RenameAddressCallBack
	reject: () => void
	approve: () => void
}

export function PersonalSign() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [personalSignRequestData, setPersonalSignRequestData] = useState<PersonalSignRequestData | undefined>(undefined)
	const [forceSend, setForceSend] = useState<boolean>(false)

	useEffect(() => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_personal_sign_request') return
			setPersonalSignRequestData(message.data)
			setRequestIdToConfirm(message.data.requestId)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage({ method: 'popup_personalSignReadyAndListening' })
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	function refreshMetadata() {
		if (personalSignRequestData === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshPersonalSignMetadata', data: personalSignRequestData })
	}

	async function approve() {
		if ( requestIdToConfirm === undefined) throw new Error('Request id is missing')
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: true } })
		globalThis.close()
	}

	async function reject() {
		if ( requestIdToConfirm === undefined) throw new Error('Request id is missing')
		await sendPopupMessageToBackgroundPage({ method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: false } })
		globalThis.close()
	}

	function isPossibleToSend(personalSignRequestData: PersonalSignRequestData, activeAddress: bigint) {
		return !(personalSignRequestData.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.originalParams.method !== 'personal_sign'))
	}

	function isConfirmDisabled(personalSignRequestData: PersonalSignRequestData, activeAddress: bigint) {
		return !isPossibleToSend(personalSignRequestData, activeAddress) && !forceSend
	}
	
	function Buttons(params: ButtonsParams) {
		const identified = identifySignature(params.personalSignRequestData)
	
		return <div style = 'display: flex; flex-direction: row;'>
			<button className = 'button is-primary is-danger button-overflow dialog-button-left' onClick = { params.reject} >
				{ identified.rejectAction }
			</button>
			<button className = 'button is-primary button-overflow dialog-button-right'
				onClick = { params.approve }
				disabled = { isConfirmDisabled(params.personalSignRequestData, params.activeAddress.address) }>
				{ params.personalSignRequestData.simulationMode ? `${ identified.simulationAction }!` :
					<SignerLogoText { ...{
						signerName: params.signerName,
						text: identified.signingAction,
					}}/>
				}
			</button>
		</div>
	}
	

	function renameAddressCallBack(entry: AddressBookEntry) {
		setAddingNewAddress({ addingAddress: false, entry: entry })
	}

	if (personalSignRequestData === undefined) {
		return <main class = 'center-to-page'>
			<div class = 'vertical-center' style = 'scale: 3'>
				<Spinner/>
				<span style = 'margin-left: 0.2em' > Visualizing... </span>
			</div>
		</main>
	}
	
	return (
		<main>
			<Hint>
				<div class = { `modal ${ addingNewAddress !== 'renameAddressModalClosed' ? 'is-active' : ''}` }>
					{ addingNewAddress === 'renameAddressModalClosed' ? <></> :
						<AddNewAddress
							setActiveAddressAndInformAboutIt = { undefined }
							addingNewAddress = { addingNewAddress }
							close = { () => { setAddingNewAddress('renameAddressModalClosed') } }
							activeAddress = { undefined }
						/>
					}
				</div>

				<div className = 'block' style = 'margin-bottom: 0px; display: flex; justify-content: space-between; flex-direction: column; height: 100%; position: fixed; width: 100%'>
					<div style = 'overflow-y: auto'>
						<header class = 'card-header window-header' style = 'height: 40px; border-top-left-radius: 0px; border-top-right-radius: 0px'>
							<div class = 'card-header-icon noselect nopointer' style = 'overflow: hidden; padding: 0px;'>
								<WebsiteOriginText { ...personalSignRequestData.website } />
							</div>
							<p class = 'card-header-title' style = 'overflow: hidden; font-weight: unset; flex-direction: row-reverse;'>
								{ personalSignRequestData.activeAddress === undefined ? <></> : <SmallAddress
									addressBookEntry = { personalSignRequestData.activeAddress }
									renameAddressCallBack = { renameAddressCallBack }
								/> }
							</p>
						</header>
						<SignatureCard
							personalSignRequestData = { personalSignRequestData }
							renameAddressCallBack = { renameAddressCallBack }
						/>
					</div>

					<nav class = 'window-header' style = 'display: flex; justify-content: space-around; width: 100%; flex-direction: column; padding-bottom: 10px; padding-top: 10px;'>
						
						{ isPossibleToSend(personalSignRequestData, personalSignRequestData.activeAddress.address) && personalSignRequestData.quarantine ? 
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorCheckBox text = { 'I understand that there are issues with this signature request but I want to send it anyway against Interceptors recommendations.' } checked = { forceSend } onInput = { setForceSend } />
								</div>
							</div>
						: <></> }
						{ personalSignRequestData.simulationMode && (personalSignRequestData.activeAddress.address === undefined || personalSignRequestData.activeAddress.address !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.originalParams.method != 'personal_sign')  ?
							<div style = 'display: grid'>
								<div style = 'margin: 0px; margin-bottom: 10px; margin-left: 20px; margin-right: 20px; '>
									<ErrorComponent text = 'Unfortunately we cannot simulate message signing as it requires private key access 😢.'/>
								</div>
							</div>
							: <></>
						}
						<Buttons
							signerName = { personalSignRequestData.signerName }
							personalSignRequestData = { personalSignRequestData }
							activeAddress = { personalSignRequestData.activeAddress }
							renameAddressCallBack = { renameAddressCallBack }
							reject = { reject }
							approve = { approve }
						/>
					</nav>
				</div>
			</Hint>
		</main>
	)
}
