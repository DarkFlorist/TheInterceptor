import { useState, useEffect } from 'preact/hooks'
import { BigAddress } from '../subcomponents/address.js'
import { AddNewAddress } from './AddNewAddress.js'
import { AddressInfoEntry, AddressBookEntry } from '../../utils/user-interface-types.js'

interface InterceptorAccessRequest {
	origin: string
	icon: string | undefined
	requestAccessToAddress: AddressInfoEntry | undefined
	addressMetadata: Map<string, AddressInfoEntry>
}

export function InterceptorAccess() {
	const [accessRequest, setAccessRequest] = useState<InterceptorAccessRequest | undefined>(undefined)
	const [isEditAddressModelOpen, setEditAddressModelOpen] = useState<boolean>(false)
	const [addressBookEntryInput, setAddressBookEntryInput] = useState<AddressBookEntry | undefined>(undefined)

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			console.log('popup message')
			console.log(msg)
			fetchAccessDialog()
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		fetchAccessDialog()

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		};
	}, []);

	async function fetchAccessDialog() {
		const backgroundPage = await browser.runtime.getBackgroundPage()
		if( !('interceptorAccessDialog' in backgroundPage.interceptor) || backgroundPage.interceptor.interceptorAccessDialog === undefined) return window.close();
		const dialog = backgroundPage.interceptor.interceptorAccessDialog

		const metadata = new Map(dialog.addressBookEntries)
		if (dialog.requestAccessToAddress !== undefined) {
			const requestAccessToAddress = metadata.get(dialog.requestAccessToAddress)
			if ( requestAccessToAddress === undefined) throw new Error('metadata missing for requested adress')
			return setAccessRequest( {
				origin: dialog.origin,
				icon: dialog.icon,
				requestAccessToAddress: requestAccessToAddress,
				addressMetadata: metadata,
			})
		}
		return setAccessRequest( {
			origin: dialog.origin,
			icon: dialog.icon,
			requestAccessToAddress: undefined,
			addressMetadata: metadata,
		})
	}

	function approve() {
		browser.runtime.sendMessage( { method: 'popup_interceptorAccess', options: { accept: true } } )
	}

	function reject() {
		browser.runtime.sendMessage( { method: 'popup_interceptorAccess', options: { accept: false } } )
	}

	function renameAddressCallBack(entry: AddressBookEntry) {
		setEditAddressModelOpen(true)
		setAddressBookEntryInput(entry)
	}

	return (
		<main>
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
			{ accessRequest === undefined ? <></> : <>
				<div className = 'block' style = 'margin-bottom: 0px; margin: 10px'>
					<header class = 'card-header window-header'>
						<div class = 'card-header-icon unset-cursor'>
							<span class = 'icon'>
								<img src = '../img/access-key.svg'/>
							</span>
						</div>
						<p class = 'card-header-title'>
							<p className = 'paragraph'>
								Website Access Request
							</p>
						</p>
					</header>
					{ accessRequest.requestAccessToAddress === undefined ? <div class = 'card-content'>
						<article class = 'media'>
							{
								accessRequest.icon === undefined ? <></> :
									<figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
										<p class = 'image is-64x64'>
											<img src = { accessRequest.icon }/>
										</p>
									</figure>
							}
						</article>
						<div class = 'media-content' style = 'padding-bottom: 20px'>
							<div class = 'content'>
								<p className = 'title' style = 'white-space: normal; text-align: center;'>
									<p className = 'title' style = 'white-space: normal; text-align: center; font-weight: bold;'>
										{ accessRequest.origin }
									</p>
								would like to connect to The Interceptor
								</p>
							</div>
						</div>
					</div> :
						<div class = 'card-content'>
							<article class = 'media'>
								{
									accessRequest.icon === undefined ? <></> :
										<figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
											<p class = 'image is-64x64'>
												<img src = { accessRequest.icon }/>
											</p>
										</figure>
								}
							</article>
							<div class = 'media-content' style = 'padding-bottom: 20px'>
								<div class = 'content'>
									<p className = 'title' style = 'white-space: normal; text-align: center;'>
										<p className = 'title' style = 'white-space: normal; text-align: center; font-weight: bold;'>
											{ accessRequest.origin }
										</p>
									would like to connect to your account
									</p>
								</div>
							</div>
							<BigAddress
								addressBookEntry = { accessRequest.requestAccessToAddress }
								renameAddressCallBack = { renameAddressCallBack }
							/>
						</div>
					}
				</div>

				{ accessRequest.addressMetadata.size <= 1 ? <></> :
					<div class = 'block' style = 'margin: 10px'>
						<header class = 'card-header'>
							<p class = 'card-header-title'>
								<p className = 'paragraph'>
								Addresses that the website can associate together
								</p>
							</p>
						</header>
						<div class = 'card-content'>
							<ul>
								{ Array.from(accessRequest.addressMetadata.entries()).map( ([_address, metadata], index) => (
									<li style = { `margin: 0px; margin-bottom: ${index < accessRequest.addressMetadata.size - 1  ? '10px;' : '0px'}` }>
										<BigAddress
											addressBookEntry = { metadata }
											renameAddressCallBack = { renameAddressCallBack }
										/>
									</li>
								)) }
							</ul>
						</div>
					</div>
				}

				<div className = 'block' style = 'padding: 10px; margin: 10px; background-color: var(--card-bg-color)'>
					<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
						<button className = 'button is-primary' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { approve } >
							Grant Access
						</button>
						<button className = 'button is-primary is-danger' style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' onClick = { reject } >
							Deny Access
						</button>
					</div>
					</div>
				<div class = 'content' style = 'height: 0.1px'/>
			</> }
		</main>
	)
}
