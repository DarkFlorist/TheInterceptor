import { useState, useEffect, useRef } from 'preact/hooks'
import { bigintToRoundedPrettyDecimalString, stringToUint8Array } from '../../utils/bigint.js'
import { BigAddress } from '../subcomponents/address.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { Error as ErrorComponent} from '../subcomponents/Error.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'
import { MessageToPopup, PersonalSignRequest } from '../../utils/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'

interface SignRequest {
	simulationMode: boolean,
	message: string,
	method: 'personal_sign' | 'eth_signTypedData' | 'eth_signTypedData_v1'| 'eth_signTypedData_v2'  | 'eth_signTypedData_v3' | 'eth_signTypedData_v4',
	account: AddressBookEntry,
}

export function PersonalSign() {
	const [requestIdToConfirm, setRequestIdToConfirm] = useState<number | undefined>(undefined)
	const [signRequest, setSignRequest] = useState<SignRequest | undefined>(undefined)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [isEditAddressModelOpen, setEditAddressModelOpen] = useState<boolean>(false)
	const [addressBookEntryInput, setAddressBookEntryInput] = useState<AddressBookEntry | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)

	useEffect( () => {
		async function popupMessageListener(msg: unknown) {
			const message = MessageToPopup.parse(msg)
			if ( message.method !== 'popup_personal_sign_request') return
			await updatePage(message)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		sendPopupMessageToBackgroundPage( { method: 'popup_personalSignReadyAndListening' } )
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		if (textareaRef && textareaRef.current) {
		  textareaRef.current.style.height = '0px'
		  const scrollHeight = textareaRef.current.scrollHeight
		  textareaRef.current.style.height = scrollHeight + 'px'
		}
	  }, [signRequest])

	async function updatePage(request: PersonalSignRequest) {
		setActiveAddress(request.data.activeAddress)
		setRequestIdToConfirm(request.data.requestId)
		const addressToSignWith = request.data.account

		switch (request.data.type) {
			case 'NotParsed': {
				return setSignRequest( {
					simulationMode: request.data.simulationMode,
					message: new TextDecoder().decode(stringToUint8Array(request.data.message)),
					account: addressToSignWith,
					method: request.data.method,
				})
			}
			case 'Permit': {
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
				})
			}
			case 'Permit2': {
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
			}
		}
	}

	function approve() {
		if ( requestIdToConfirm === undefined) throw new Error('Request id is missing')
		sendPopupMessageToBackgroundPage( { method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: true } } )
	}

	function reject() {
		if ( requestIdToConfirm === undefined) throw new Error('Request id is missing')
		sendPopupMessageToBackgroundPage( { method: 'popup_personalSign', options: { requestId: requestIdToConfirm, accept: false } } )
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setEditAddressModelOpen(true)
		setAddressBookEntryInput(entry)
	}

	return (
		<main>
			<Hint>
				<div class = { `modal ${ isEditAddressModelOpen? 'is-active' : ''}` }>
					<AddNewAddress
						setActiveAddressAndInformAboutIt = { undefined }
						addressBookEntry = { addressBookEntryInput }
						setAddressBookEntryInput = { setAddressBookEntryInput }
						addingNewAddress = { false }
						close = { () => { setEditAddressModelOpen(false) } }
						activeAddress = { undefined }
					/>
				</div>
				<div className = 'block' style = 'margin: 10px; margin-bottom: 0px'>
					{ signRequest === undefined ? <></> : <>
						<header class = 'card-header'>
							{ signRequest.simulationMode ? <>
								<div class = 'card-header-icon unset-cursor'>
									<span class = 'icon' style = 'height: 4rem; width: 3rem;'>
										<img src = '../img/head-simulating.png'/>
									</span>
								</div>
								<p class = 'card-header-title'>
									<p className = 'paragraph'>
										Signature Request - Simulating
									</p>
								</p>
							</>
							: <>
								<div class = 'card-header-icon unset-cursor'>
									<span class = 'icon' style = 'height: 4rem; width: 3rem;'>
										<img src = '../img/head-signing.png'/>
									</span>
								</div>
								<p class = 'card-header-title'>
									<p className = 'paragraph'>
										Signature Request - Live Signing
									</p>
								</p>
							</>}
						</header>
						<div class = 'card-content'>
							<BigAddress
								addressBookEntry = { signRequest.account }
								renameAddressCallBack = { renameAddressCallBack }
							/>
						</div>

						<div class = 'block' style = 'background-color: var(--card-bg-color); margin-top: 10px; margin-bottom: 10px;'>
							<header class = 'card-header'>
								<p class = 'card-header-title'>
									<p className = 'paragraph'>
										Message
									</p>
								</p>
							</header>
							<div class = 'card-content'>
								<div class = 'control'>
									<textarea class = 'textarea' readonly ref = { textareaRef } style = 'overflow: hidden; resize: none;'>{ signRequest.message }</textarea>
								</div>
							</div>
						</div>

						<div className = 'block' style = 'padding: 10px; background-color: var(--card-bg-color);'>
							<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px; margin-bottom: 10px;'>
								<button
									className = 'button is-primary'
									style = 'flex-grow: 1; margin-left:5px; margin-right:5px;'
									onClick = { approve }
									disabled = { signRequest.simulationMode && (activeAddress === undefined || activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || signRequest.method  != 'personal_sign') }
								>
									{ signRequest.simulationMode ? 'Simulate!' : 'Forward to wallet for signing' }
								</button>
								<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
									Reject
								</button>
							</div>
							{ signRequest.simulationMode && (activeAddress === undefined || activeAddress !== MOCK_PRIVATE_KEYS_ADDRESS || signRequest.method  != 'personal_sign')  ?
								<ErrorComponent text = 'Unfortunately we cannot simulate message signing as it requires private key access 😢.'/>
								: <></>
							}
						</div>
					</> }
				</div>
				<div class = 'content' style = 'height: 0.1px'/>
			</Hint>
		</main>
	)
}
