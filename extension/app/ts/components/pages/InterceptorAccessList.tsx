import { InterceptorAccessListParams, Page } from '../../utils/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { WebsiteAccess, WebsiteAddressAccess } from '../../background/settings.js'
import { AddressMetadata } from '../../utils/visualizer-types.js'
import { SmallAddress } from '../subcomponents/address.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'

interface ModifiedAddressAccess {
	address: string,
	access: boolean,
	removed: boolean,
}

interface EditableAccess {
	websiteAccess: WebsiteAccess,
	addressAccess: readonly WebsiteAddressAccess[],
	addressAccessModified: readonly ModifiedAddressAccess[],
	access: boolean,
	removed: boolean,
}

export function InterceptorAccessList(param: InterceptorAccessListParams) {
	const [editableAccessList, setEditableAccessList] = useState<readonly EditableAccess[] | undefined>(undefined)
	const [metadata, setMetadata] = useState<Map<string, AddressMetadata>>(new Map())

	function updateEditableAccessList(websiteAccess: readonly WebsiteAccess[] | undefined = undefined) {
		const newList = websiteAccess ? websiteAccess : param.websiteAccess
		if ( newList === undefined ) return setEditableAccessList(undefined)
		setEditableAccessList(newList.map( (x) => ({
			websiteAccess: x,
			addressAccess: x.addressAccess === undefined ? [] : x.addressAccess,
			addressAccessModified: x.addressAccess === undefined ? [] : x.addressAccess.map( (addr) => ({
				address: addr.address,
				access: addr.access,
				removed: false,
			})),
			access: x.access,
			removed: false,
		})))
	}

	useEffect( () => {
		updateEditableAccessList()
		setMetadata(new Map(param.websiteAccessAddressMetadata))
	}, [])

	useEffect( () => {
		updateEditableAccessList()
		setMetadata(new Map(param.websiteAccessAddressMetadata))
	}, [param.websiteAccess, param.websiteAccessAddressMetadata])

	function goHome() {
		param.setAndSaveAppPage(Page.Home)
	}

	function setWebsiteAccess(index: number, access: boolean | undefined, removed: boolean | undefined) {
		if (editableAccessList === undefined) return
		setEditableAccessList( editableAccessList.map( (x , i) => {
			if(index === i ) {
				return {
					websiteAccess: x.websiteAccess,
					addressAccess: x.addressAccess,
					addressAccessModified: x.addressAccessModified,
					access: access === undefined ? x.access : access,
					removed: removed === undefined ? x.removed : removed,
				}
			}
			return x
		}))
	}

	function setAddressAccess(index: number, addressIndex: number, access: boolean | undefined, removed: boolean | undefined) {
		if (editableAccessList === undefined) return
		setEditableAccessList( editableAccessList.map( (x , i) => {
			if(index === i ) {
				return {
					websiteAccess: x.websiteAccess,
					addressAccess: x.addressAccess,
					addressAccessModified: x.addressAccessModified.map( (addr, addrIndex) => ({
						address: addr.address,
						access: addrIndex === addressIndex && access !== undefined ? access : addr.access,
						removed: addrIndex === addressIndex && removed !== undefined ? removed : addr.removed
					})),
					access: x.access,
					removed: x.removed
				}
			}
			return x
		}))
	}

	function hasChanged(state: EditableAccess) {
		if (state.removed || state.access !== state.websiteAccess.access) return true
		for ( const [index, access] of state.addressAccessModified.entries()) {
			if (access.removed || state.addressAccess[index].access !== access.access) {
				return true
			}
		}
		return false
	}
	function areThereChanges() {
		if (editableAccessList === undefined) return false
		for (const state of editableAccessList) {
			if ( hasChanged(state) ) return true
		}

		return false
	}

	function saveChanges() {
		if (!areThereChanges()) return goHome()
		if (editableAccessList === undefined) return goHome()

		const withoutRemovedEntries = editableAccessList.filter( (state) => !state.removed )
		const newEntries = withoutRemovedEntries.map( (x) => ({
			origin: x.websiteAccess.origin,
			originIcon: x.websiteAccess.originIcon,
			access: x.access,
			addressAccess: x.addressAccessModified.filter( (x) => !x.removed ).map( (addr) => ({
				address: addr.address,
				access: addr.access,
			})),
		}))
		browser.runtime.sendMessage( { method: 'popup_changeInterceptorAccess', options: newEntries } )
		updateEditableAccessList(newEntries)
		param.setWebsiteAccess(newEntries)
		return goHome()
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/internet.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
					Website Access
					</p>
				</p>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { goHome }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body'>
				<ul>
					{ editableAccessList !== undefined && editableAccessList.length === 0 ?
						<li>
							<div class = 'card'>
								<div class = 'card-content'>
									<div class = 'media'>
										<div class = 'media-content' style = 'overflow-y: visible; overflow-x: unset;'>
											<p className = 'paragraph'> No website is given access to The Interceptor </p>
										</div>
									</div>
								</div>
							</div>
						</li>
					: <></> }
					{ editableAccessList === undefined ? <></> : editableAccessList.map( (access, accessListIndex) => (
						<li>
							{ access.removed ? <p style = 'color: var(--negative-color)' > { `Forgot ${ access.websiteAccess.origin }. `}</p> :
								<div class = 'card'>
									<div class = 'card-header'>
										<div class = 'card-header-icon unset-cursor' >
											<p class = 'image is-24x24'>
												<img src = { access.websiteAccess.originIcon === undefined ? '../../img/question-mark-sign.svg' : access.websiteAccess.originIcon }/>
											</p>
										</div>
										<p class = 'card-header-title' style = 'width: 13em'>
											<CopyToClipboard
												content = { access.websiteAccess.origin }
												copyMessage = 'Website address copied!'
											>
												<p className = 'paragraph noselect nopointer' style = 'text-overflow: ellipsis; overflow: hidden; white-space: nowrap; display: block; width: 13em'>
													{ access.websiteAccess.origin }
												</p>
											</CopyToClipboard>
										</p>
										<div class = 'card-header-icon unset-cursor'>
											<label class = 'form-control' style = 'width: 8em;'>
												<input type = 'checkbox' checked = { access.access } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setWebsiteAccess(accessListIndex, e.target.checked ,undefined) } } } />
												Allow access
											</label>
											<button class = 'card-header-icon' style = 'padding: 0px;' aria-label = 'forget' onClick = { () => setWebsiteAccess(accessListIndex, undefined, true) }>
												<span class = 'icon' style = 'color: var(--text-color);'> X </span>
											</button>
										</div>
									</div>
									<div class = 'card-content' style = 'margin-bottom: 0px;'>
										{ access.addressAccess.length === 0 ? <p className = 'paragraph'> No individual address accesses given </p> : <>
											{ access.addressAccessModified.map( (websiteAccessAddress, addressIndex) => (
												<li style = { `margin: 0px; margin-bottom: ${ addressIndex < access.addressAccessModified.length - 1  ? '10px;' : '0px' }` }>
													{ websiteAccessAddress.removed ? <p style = 'color: var(--negative-color)' > { `Forgot ${ websiteAccessAddress.address }`} </p> :
														<div style = 'display: flex; width: 100%; overflow: hidden;'>
															<SmallAddress
																address = { BigInt(websiteAccessAddress.address) }
																addressMetaData = { metadata.get(websiteAccessAddress.address) }
																renameAddressCallBack = { param.renameAddressCallBack }
															/>
															<div style = 'margin-left: auto; flex-shrink: 0; display: flex'>
																<label class = 'form-control' style = 'margin: auto'>
																	<input type = 'checkbox' checked = { websiteAccessAddress.access } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAddressAccess(accessListIndex, addressIndex, e.target.checked, undefined) } } } />
																	<p class = 'paragraph' style = 'white-space: nowrap;'>Allow access</p>
																</label>
																<button class = 'card-header-icon' style = 'padding: 0px;' aria-label = 'forget' onClick = { () => setAddressAccess(accessListIndex, addressIndex, undefined, true) }>
																	<span class = 'icon' style = 'color: var(--text-color);'> X </span>
																</button>
															</div>
														</div>
													}
												</li>
											)) }
										</> }
									</div>
								</div>
							}
						</li>
					) ) }
				</ul>
			</section>

			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-success is-primary' onClick = { saveChanges }> { areThereChanges() ? 'Save Changes' : 'Close' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { goHome }>Cancel</button>
			</footer>
		</div>
	</> )
}
