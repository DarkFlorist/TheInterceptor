import { useState, useEffect } from 'preact/hooks'
import { stringToUint8Array } from '../../utils/bigint.js'
import { AddingNewAddressType, AddressBookEntry, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { ErrorCheckBox, Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { ExternalPopupMessage, PersonalSignRequest, PersonalSignRequestData, SignerName } from '../../utils/interceptor-messages.js'
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
		case 'EIP712': return {
			title: 'Arbitary EIP712 message signing request',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
		}
		case 'NotParsed': return {
			title: 'Arbitary Ethereum message signing request',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
		}
		case 'Permit': return {
			title: 'Permit message signing request',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
			to: data.addressBookEntries.spender
		}
		case 'Permit2': return {
			title: 'Permit2 message signing request',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
			to: data.addressBookEntries.spender
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
			{'addressBookEntries' in params.personalSignRequestData ?
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
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ new TextDecoder().decode(stringToUint8Array(personalSignRequestData.message)) }</p>
			</div>
		}
		case 'EIP712': {
			return <div class = 'textbox'>
				<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ JSON.stringify(personalSignRequestData.message) }</p>
			</div>
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


type ExtraDetailsCardParams = {
	personalSignRequestData: PersonalSignRequestData
}
export function ExtraDetails({ personalSignRequestData }: ExtraDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(true)

	const CellElement = (param: { text: ComponentChildren }) => {
		return <div class = 'log-cell' style = 'justify-content: right;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'> { param.text }</p></div>
	}

	if (personalSignRequestData.type !== 'Permit2' && personalSignRequestData.type !== 'Permit') {
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
						<CellElement text = 'Chain: '/>
						<CellElement text = { getChainName(BigInt(personalSignRequestData.message.domain.chainId)) }/>
						{ personalSignRequestData.type !== 'Permit2' ? <></> : <>
							<CellElement text = 'Nonce: '/>
							<CellElement text = { personalSignRequestData.message.message.details.nonce.toString(10) }/>
							<CellElement text = 'Signature expires in:'/>
							<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(personalSignRequestData.message.message.sigDeadline) * 1000) } countBackwards = { true }/> }/>
							<CellElement text = 'Spender can spend for:'/>
							<CellElement text = { <>
								<SomeTimeAgo priorTimestamp = { new Date(Number(personalSignRequestData.message.message.details.expiration) * 1000) } countBackwards = { true }/>
								{` (until ${ new Date(Number(personalSignRequestData.message.message.details.expiration) * 1000).toISOString().split('T')[0] })`}
							</> }/>
						</> }
						{ personalSignRequestData.type !== 'Permit' ? <></> : <>
							<CellElement text = 'Nonce: '/>
							<CellElement text = { personalSignRequestData.message.message.nonce.toString(10) }/>
							<CellElement text = 'Signature expires in:'/>
							<CellElement text = { <SomeTimeAgo priorTimestamp = { new Date(Number(personalSignRequestData.message.message.deadline) * 1000) } countBackwards = { true }/> }/>
						</> }
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

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_addressBookEntriesChanged') return refreshMetadata()
			if (message.method !== 'popup_personal_sign_request') return
			setPersonalSignRequestData(message.data)
			updatePage(message)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage({ method: 'popup_personalSignReadyAndListening' })
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	function refreshMetadata() {
		if (personalSignRequestData === undefined) return
		sendPopupMessageToBackgroundPage({ method: 'popup_refreshPersonalSignMetadata', data: personalSignRequestData })
	}

	function updatePage(request: PersonalSignRequest) {
		setRequestIdToConfirm(request.data.requestId)
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
		return !(personalSignRequestData.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.method !== 'personal_sign'))
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
					<SignerLogoText {...{
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
	
	//TODO, add check that domains match, and active address and account match

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
						{ personalSignRequestData.simulationMode && (personalSignRequestData.activeAddress.address === undefined || personalSignRequestData.activeAddress.address !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.method  != 'personal_sign')  ?
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
