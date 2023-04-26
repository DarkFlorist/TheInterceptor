import { useState, useEffect } from 'preact/hooks'
import { stringToUint8Array } from '../../utils/bigint.js'
import { AddingNewAddressType, AddressBookEntry, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { ExternalPopupMessage, PersonalSignRequest, PersonalSignRequestData, SignerName } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { assertNever } from '../../utils/typescript.js'
import { SimpleTokenApprovalVisualisation } from '../simulationExplaining/customExplainers/SimpleTokenApprovalVisualisation.js'
import { SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { SignerLogoText } from '../subcomponents/signers.js'
import { Spinner } from '../subcomponents/Spinner.js'

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
			title: 'EIP712',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
		}
		case 'NotParsed': return {
			title: 'NotParsed',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
		}
		case 'Permit': return {
			title: 'Permit',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
		}
		case 'Permit2': return {
			title: 'Permit',
			rejectAction: 'hello',
			simulationAction: 'hello2',
			signingAction: 'hello2',
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
			<SmallAddress
				addressBookEntry = { params.personalSignRequestData.account }
				renameAddressCallBack = { params.renameAddressCallBack }
				style = { { 'background-color': 'unset' } }
			/>
		</p>
	</header>
}

type SignRequestParams = {
	personalSignRequestData: PersonalSignRequestData
	renameAddressCallBack: RenameAddressCallBack
}

function SignRequest( {personalSignRequestData, renameAddressCallBack }: SignRequestParams) {
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
			if (personalSignRequestData.addressBookEntries.verifyingContract.type !== 'token') throw new Error("fixme")
			const chainId = personalSignRequestData.message.domain.chainId.toString()
			if (chainId !== '1') throw new Error("fixme")
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
				chainId = { chainId }
				renameAddressCallBack = { renameAddressCallBack }
			/>
			// muista näyttää chain id, nonce, timestamp
/*
			const chainName = getChainName(BigInt(request.data.message.domain.chainId))
			const verifyingContract = request.data.addressBookEntries.verifyingContract
			const spenderMetaData = request.data.addressBookEntries.spender
			const decimals = 'decimals' in request.data.addressBookEntries.verifyingContract ? request.data.addressBookEntries.verifyingContract.decimals : undefined
			const value = decimals ? bigintToRoundedPrettyDecimalString( request.data.message.message.value, decimals, 4n) : request.data.message.message.value
			const message =  `Approve ${ verifyingContract.name } on ${ chainName } for ${ spenderMetaData.name } for value ${ value } with nonce ${ request.data.message.message.nonce }. Valid until ${ new Date( request.data.message.message.deadline * 1000).toISOString() }.`
			return setSignRequest( {
				simulationMode: request.data.simulationMode,
				message: message,
				account: addressToSignWith,
				method: request.data.method,
			})*/
		}
		case 'Permit2': {
			if (personalSignRequestData.addressBookEntries.token.type !== 'token') throw new Error("fixme")
			const chainId = personalSignRequestData.message.domain.chainId.toString()
			if (chainId !== '1') throw new Error("fixme")

			return <SimpleTokenApprovalVisualisation
				approval = { {
					type: 'Token',
					from: personalSignRequestData.account,
					to: personalSignRequestData.addressBookEntries.spender,
					token: personalSignRequestData.addressBookEntries.token,
					amount: personalSignRequestData.message.message.details.amount,
					isApproval: true
				} }
				transactionGasses = { { gasSpent: 0n, realizedGasPrice: 0n } }
				chainId = { chainId }
				renameAddressCallBack = { renameAddressCallBack }
			/>
			/*
			const chainName = getChainName(BigInt(request.data.message.domain.chainId))
			const verifyingContract = request.data.addressBookEntries.verifyingContract
			const spenderMetaData = request.data.addressBookEntries.spender
			const decimals = 'decimals' in request.data.addressBookEntries.token ? request.data.addressBookEntries.token.decimals : undefined
			const value = decimals ? bigintToRoundedPrettyDecimalString( request.data.message.message.details.amount, decimals, 4n) : request.data.message.message.details.amount
			const message =  `Approve ${ verifyingContract.name } on ${ chainName } for ${ spenderMetaData.name } for value ${ value } (${ request.data.addressBookEntries.token.name }) with nonce ${ request.data.message.message.details.nonce }. Valid until ${ new Date( Number(request.data.message.message.details.expiration) * 1000).toISOString() }.`
			return setSignRequest( {
				simulationMode: request.data.simulationMode,
				message: message,
				account: addressToSignWith,
				method: request.data.method,
			})
			*/
		}
		default: assertNever(personalSignRequestData)
	}
}

function SignatureCard(params: SignatureCardParams) {
	return <>
		<div class = 'card' style = 'margin: 10px;'>
			<SignatureHeader { ...params }/>
			<div class = 'card-content' style = 'padding-bottom: 5px;'>
				<div class = 'container'>
					<SignRequest { ...params }/>
				</div>
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

function isConfirmDisabled(personalSignRequestData: PersonalSignRequestData, activeAddress: bigint) {
	return personalSignRequestData.simulationMode && (activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.method  !== 'personal_sign')
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

export function PersonalSign() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [addingNewAddress, setAddingNewAddress] = useState<AddingNewAddressType | 'renameAddressModalClosed'> ('renameAddressModalClosed')
	const [personalSignRequestData, setPersonalSignRequestData] = useState<PersonalSignRequestData | undefined>(undefined)

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
		await sendPopupMessageToBackgroundPage( { method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: true } } )
		globalThis.close()
	}

	async function reject() {
		if ( requestIdToConfirm === undefined) throw new Error('Request id is missing')
		await sendPopupMessageToBackgroundPage( { method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: false } } )
		globalThis.close()
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
						{ personalSignRequestData.simulationMode && (personalSignRequestData.activeAddress.address === undefined || personalSignRequestData.activeAddress.address !== MOCK_PRIVATE_KEYS_ADDRESS || personalSignRequestData.method  != 'personal_sign')  ?
							<ErrorComponent text = 'Unfortunately we cannot simulate message signing as it requires private key access 😢.'/>
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
