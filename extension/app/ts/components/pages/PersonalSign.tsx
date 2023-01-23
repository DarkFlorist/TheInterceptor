import { useState, useEffect, useRef } from 'preact/hooks'
import { bigintToRoundedPrettyDecimalString, stringToUint8Array } from '../../utils/bigint.js'
import { InterceptedRequest } from '../../utils/interceptor-messages.js'
import { EthereumAddress } from '../../utils/wire-types.js'
import { BigAddress, findAddressInfo } from '../subcomponents/address.js'
import { AddressInfo } from '../../utils/user-interface-types.js'
import Hint from '../subcomponents/Hint.js'
import { Error as ErrorComponent} from '../subcomponents/Error.js'
import { getAddressMetaData } from '../../background/metadataUtils.js'
import { MOCK_PRIVATE_KEYS_ADDRESS, getChainName } from '../../utils/constants.js'
import { AddNewAddress } from './AddNewAddress.js'

interface SignRequest {
	simulationMode: boolean,
	message: string,
	account: bigint,
	addressInfo: AddressInfo,
}

export function PersonalSign() {
	const [requestToConfirm, setRequestToConfirm] = useState<InterceptedRequest | undefined>(undefined)
	const [signRequest, setSignRequest] = useState<SignRequest | undefined>(undefined)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [isEditAddressModelOpen, setEditAddressModelOpen] = useState<boolean>(false)
	const [addressInput, setAddressInput] = useState<string | undefined>(undefined)
	const [nameInput, setNameInput] = useState<string | undefined>(undefined)
	const [activeSimulationAddress, setActiveSimulationAddress] = useState<bigint | undefined>(undefined)

	useEffect( () => {
		function popupMessageListener(_msg: unknown) {
			fetchSignableMessage()
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		fetchSignableMessage()

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		if (textareaRef && textareaRef.current) {
		  textareaRef.current.style.height = '0px'
		  const scrollHeight = textareaRef.current.scrollHeight
		  textareaRef.current.style.height = scrollHeight + 'px'
		}
	  }, [signRequest])

	async function fetchSignableMessage() {
		const backgroundPage = await browser.runtime.getBackgroundPage()
		if( !('personalSignDialog' in backgroundPage.interceptor) || backgroundPage.interceptor.personalSignDialog === undefined) return window.close();
		if (backgroundPage.interceptor.settings === undefined) return window.close()

		const req = InterceptedRequest.parse(backgroundPage.interceptor.personalSignDialog.requestToConfirm)
		setRequestToConfirm(req)
		setActiveSimulationAddress(backgroundPage.interceptor.settings.activeSimulationAddress)
		const dialog = backgroundPage.interceptor.personalSignDialog
		const addressToSignWith = EthereumAddress.parse(dialog.account)
		const addressInfo = findAddressInfo(addressToSignWith, backgroundPage.interceptor.settings === undefined ? [] : backgroundPage.interceptor.settings.addressInfos)
		if (dialog.eip2612Message !== undefined) {
			const chainName = getChainName(BigInt(dialog.eip2612Message.domain.chainId))
			const verifyingContract = dialog.eip2612Message.domain.verifyingContract
			const verifyingContractMetadata = getAddressMetaData(verifyingContract, backgroundPage.interceptor.settings.addressInfos)
			const spenderMetaData = getAddressMetaData(dialog.eip2612Message.message.spender, backgroundPage.interceptor.settings.addressInfos)
			const decimals = 'decimals' in verifyingContractMetadata ? verifyingContractMetadata.decimals : undefined
			const value = decimals ? bigintToRoundedPrettyDecimalString(dialog.eip2612Message.message.value, decimals, 4n) : dialog.eip2612Message.message.value
			const message =  `Approve ${ verifyingContractMetadata.name } on ${ chainName } for ${ spenderMetaData.name } for value ${ value } with nonce ${ dialog.eip2612Message.message.nonce }. Valid until ${ new Date(dialog.eip2612Message.message.deadline * 1000).toISOString() }.`
			setSignRequest( {
				simulationMode: dialog.simulationMode,
				message: message,
				account: addressToSignWith,
				addressInfo: addressInfo,
			})
		} else {
			setSignRequest( {
				simulationMode: dialog.simulationMode,
				message: new TextDecoder().decode(stringToUint8Array(dialog.message)),
				account: addressToSignWith,
				addressInfo: addressInfo,
			})
		}
	}

	function approve() {
		browser.runtime.sendMessage( { method: 'popup_personalSign', options: { request: requestToConfirm, accept: true } } )
	}

	function reject() {
		browser.runtime.sendMessage( { method: 'popup_personalSign', options: { request: requestToConfirm, accept: false } } )
	}

	function renameAddressCallBack(name: string | undefined, address: string) {
		setEditAddressModelOpen(true)
		setAddressInput(address)
		setNameInput(name)
	}

	return (
		<main>
			<Hint>
				<div class = { `modal ${ isEditAddressModelOpen? 'is-active' : ''}` }>
					<AddNewAddress
						setActiveAddressAndInformAboutIt = { undefined }
						addressInput = { addressInput }
						nameInput = { nameInput }
						addingNewAddress = { false }
						setAddressInput = { setAddressInput }
						setNameInput = { setNameInput }
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
								address = { signRequest.account }
								nameAndLogo = { { name: signRequest.addressInfo.name, logoUri: undefined } }
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
									disabled = { signRequest.simulationMode && (activeSimulationAddress === undefined || activeSimulationAddress !== MOCK_PRIVATE_KEYS_ADDRESS) }
								>
									{ signRequest.simulationMode ? 'Simulate!' : 'Forward to wallet for signing' }
								</button>
								<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
									Reject
								</button>
							</div>
							{ signRequest.simulationMode && (activeSimulationAddress === undefined || activeSimulationAddress !== MOCK_PRIVATE_KEYS_ADDRESS)  ?
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
