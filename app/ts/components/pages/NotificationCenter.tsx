import { useEffect, useState } from 'preact/hooks'
import { AddressInfoEntry, NotificationCenterParams, Website, WebsiteSocket } from '../../utils/user-interface-types.js'
import { BigAddress } from '../subcomponents/address.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptedRequest } from '../../utils/interceptor-messages.js'

export type PendingAccessRequestWithMetadata = AddressInfoEntry & {
	request: InterceptedRequest | undefined
	socket: WebsiteSocket,
	website: Website,
} | {
	request: InterceptedRequest | undefined
	socket: WebsiteSocket,
	website: Website,
	address: undefined
}

export function NotificationCenter(param: NotificationCenterParams) {

	const [pendingAccessRequests, setPendingAccessRequests] = useState<PendingAccessRequestWithMetadata[] | undefined>(undefined)

	useEffect( () => {
		if (param.pendingAccessRequests == undefined) return setPendingAccessRequests(undefined)
		const metadata = new Map(param.pendingAccessMetadata)
		setPendingAccessRequests(param.pendingAccessRequests.map( (x) => ({
			website: x.website,
			socket: x.socket,
			request: x.request,
			...(x.requestAccessToAddress === undefined ? { address: undefined } : metadata.get(addressString(x.requestAccessToAddress)) || { // TODO, refactor away when we are using messaging instead of globals for these
				type: 'addressInfo' as const,
				name: checksummedAddress(x.requestAccessToAddress),
				address: x.requestAccessToAddress,
				askForAddressAccess: false,
			})
		}) ) )
	}, [param.pendingAccessRequests, param.pendingAccessMetadata])

	function goHome() {
		param.setAndSaveAppPage('Home')
	}

	function review(pendingAccessRequest: PendingAccessRequestWithMetadata) {
		sendPopupMessageToBackgroundPage({
			method: 'popup_reviewNotification',
			options: {
				socket: {
					...pendingAccessRequest.socket
				},
				website: pendingAccessRequest.website,
				request: pendingAccessRequest.request,
				requestAccessToAddress: pendingAccessRequest.address,
			}
		} )
	}

	function reject(website: Website, requestAccessToAddress: bigint | undefined, removeOnly: boolean) {
		sendPopupMessageToBackgroundPage({
			method: 'popup_rejectNotification',
			options: {
				website: website,
				requestAccessToAddress: requestAccessToAddress,
				removeOnly: removeOnly,
			}
		} )
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class='modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/notification-bell.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
						Notifications
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { goHome }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'min-height: 100px'>
				{ pendingAccessRequests === undefined ?
					<p className = 'paragraph' style = 'text-align: center; margin-top: 10%; margin-bottom: 10%;'> Loading... </p>

				: pendingAccessRequests.length === 0 ?
					<p className = 'paragraph' style = 'text-align: center; margin-top: 10%; margin-bottom: 10%;'> All clear! Nothing to notify! </p>
				:
					<ul>
						{ pendingAccessRequests.map( (pendingAccessRequest) => (
						<li>
							<div class = 'card'>
								<div class = 'card-header'>
									<div class = 'card-header-icon unset-cursor' >
										<p class = 'image is-24x24'>
											<img src = { pendingAccessRequest.website.icon === undefined ? '../../img/question-mark-sign.svg' : pendingAccessRequest.website.icon }/>
										</p>
									</div>
									<p class = 'card-header-title' style = 'width: 60%'>
										<p className = 'paragraph' style = 'text-overflow: ellipsis; overflow: hidden;'>
											{ pendingAccessRequest.address === undefined ? 'The Interceptor access request' : 'Address access request' }
										</p>
									</p>
									<button class = 'card-header-icon' onClick = { () => reject(pendingAccessRequest.website, pendingAccessRequest.address, true) } >
										<span class = 'icon' style = 'color: var(--text-color);'> X </span>
									</button>

								</div>
								<div class = 'card-content' style = 'margin-bottom: 0px;'>
									{ pendingAccessRequest.address === undefined ?
										<p className = 'paragraph' style = 'padding-bottom: 10px; word-break: break-word;'>
											<span className = 'paragraph' style = 'font-weight: bold;'>
												{ `${ pendingAccessRequest.website.websiteOrigin }` }
											</span>
											<span> would like to connect to The Interceptor </span>
										</p>
									:
									<>
										<div class = 'media-content' style = 'padding-bottom: 10px'>
											<p className = 'paragraph' style = 'word-break: break-word;'>
												<span className = 'paragraph' style = 'font-weight: bold;'>
													{ `${ pendingAccessRequest.website.websiteOrigin }` }
												</span>
												<span> would like to connect to your account </span>
											</p>
										</div>
										<BigAddress
											addressBookEntry = { pendingAccessRequest }
											renameAddressCallBack = { param.renameAddressCallBack }
										/>

										<div style = 'padding-bottom: 10px'/>
									</>

									}
									<button className = 'button is-primary is-small' onClick = { () => review(pendingAccessRequest) }>
										Review
									</button>

									<button className = 'button is-primary is-small' style = 'background-color: var(--negative-color); margin-left: 10px;' onClick = { () => reject(pendingAccessRequest.website, pendingAccessRequest.address, false) }>
										Decline
									</button>
								</div>
							</div>
						</li>
					) ) }
					</ul>
				}
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-success is-primary'  onClick = { goHome } > Close </button>
			</footer>
		</div>
	</> )
}
