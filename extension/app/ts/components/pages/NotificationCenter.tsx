import { useEffect, useState } from 'preact/hooks'
import { NotificationCenterParams, Page, PendingAccessRequest } from '../../utils/user-interface-types.js'
import { AddressMetadata } from '../../utils/visualizer-types.js'
import { BigAddress } from '../subcomponents/address.js'

export function NotificationCenter(param: NotificationCenterParams) {

	const [pendingAcessRequests, setPendingAccessRequests] = useState<PendingAccessRequest[] | undefined>(undefined)
	const [addressMetadata, setAddressMetadata] = useState< Map<string, AddressMetadata> >( new Map() )

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			console.log('popup message')
			console.log(msg)
			updateList()
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		updateList()

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	async function updateList() {
		const backgroundPage = await browser.runtime.getBackgroundPage()
		if ( backgroundPage.interceptor.settings === undefined) return
		setPendingAccessRequests( backgroundPage.interceptor.settings.pendingAccessRequests.map( (x) => ({
			origin: x.origin,
			icon: x.icon,
			requestAccessToAddress: x.requestAccessToAddress,
		}) ) )
		setAddressMetadata(new Map(backgroundPage.interceptor.pendingAccessMetadata))
	}

	function goHome() {
		param.setAndSaveAppPage(Page.Home)
	}

	function review(origin: string, requestAccessToAddress: string | undefined) {
		browser.runtime.sendMessage( { method: 'popup_reviewNotification', options: {
			origin: origin,
			requestAccessToAddress: requestAccessToAddress
		} } )
	}

	function reject(origin: string, requestAccessToAddress: string | undefined, removeOnly: boolean) {
		browser.runtime.sendMessage( { method: 'popup_rejectNotification', options: {
			origin: origin,
			requestAccessToAddress: requestAccessToAddress,
			removeOnly: removeOnly
		} } )
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
				{ pendingAcessRequests === undefined ?
					<p className = 'paragraph' style = 'text-align: center; margin-top: 10%; margin-bottom: 10%;'> Loading... </p>

				: pendingAcessRequests.length === 0 ?
					<p className = 'paragraph' style = 'text-align: center; margin-top: 10%; margin-bottom: 10%;'> All clear! Nothing to notify! </p>
				:
					<ul>
						{ pendingAcessRequests.map( (pendingAccessRequest) => (
						<li>
							<div class = 'card'>
								<div class = 'card-header'>
									<div class = 'card-header-icon unset-cursor' >
										<p class = 'image is-24x24'>
											<img src = { pendingAccessRequest.icon === undefined ? '../../img/question-mark-sign.svg' : pendingAccessRequest.icon }/>
										</p>
									</div>
									<p class = 'card-header-title' style = 'width: 60%'>
										<p className = 'paragraph' style = 'text-overflow: ellipsis; overflow: hidden;'>
											{ pendingAccessRequest.requestAccessToAddress === undefined ? 'The Interceptor access request' : 'Address access request' }
										</p>
									</p>
									<button class = 'card-header-icon' onClick = { () => reject(pendingAccessRequest.origin, pendingAccessRequest.requestAccessToAddress, true) } >
										<span class = 'icon' style = 'color: var(--text-color);'> X </span>
									</button>

								</div>
								<div class = 'card-content' style = 'margin-bottom: 0px;'>
									{ pendingAccessRequest.requestAccessToAddress === undefined ?
										<p className = 'paragraph' style = 'padding-bottom: 10px; word-break: break-word;'>
											<span className = 'paragraph' style = 'font-weight: bold;'>
												{ `${ pendingAccessRequest.origin }` }
											</span>
											<span> would like to connect to The Interceptor </span>
										</p>
									:
									<>
										<div class = 'media-content' style = 'padding-bottom: 10px'>
											<p className = 'paragraph' style = 'word-break: break-word;'>
												<span className = 'paragraph' style = 'font-weight: bold;'>
													{ `${ pendingAccessRequest.origin }` }
												</span>
												<span> would like to connect to your account </span>
											</p>
										</div>
										<BigAddress
											address = { BigInt(pendingAccessRequest.requestAccessToAddress) }
											nameAndLogo = { addressMetadata.get(pendingAccessRequest.requestAccessToAddress) }
											renameAddressCallBack = { param.renameAddressCallBack }
										/>

										<div style = 'padding-bottom: 10px'/>
									</>

									}
									<button className = 'button is-primary is-small' onClick = { () => review(pendingAccessRequest.origin, pendingAccessRequest.requestAccessToAddress) }>
										Review
									</button>

									<button className = 'button is-primary is-small' style = 'background-color: var(--negative-color); margin-left: 10px;' onClick = { () => reject(pendingAccessRequest.origin, pendingAccessRequest.requestAccessToAddress, false) }>
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
