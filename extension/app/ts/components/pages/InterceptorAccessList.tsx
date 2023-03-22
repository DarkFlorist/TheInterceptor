import { AddressInfoEntry, InterceptorAccessListParams } from '../../utils/user-interface-types.js'
import { useEffect, useState } from 'preact/hooks'
import { SmallAddress } from '../subcomponents/address.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { addressString, checksummedAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { WebsiteAccess, WebsiteAccessArray, WebsiteAddressAccess } from '../../utils/interceptor-messages.js'

interface ModifiedAddressAccess {
	address: bigint,
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
	const [metadata, setMetadata] = useState<Map<string, AddressInfoEntry>>(new Map())

	function updateEditableAccessList(newList: WebsiteAccessArray | undefined) {
		if (newList === undefined) return setEditableAccessList(undefined)
		setEditableAccessList((editableAccessList) => {
			if (editableAccessList === undefined) {
				return newList.map( (x) => ({
					websiteAccess: x,
					addressAccess: x.addressAccess === undefined ? [] : x.addressAccess,
					addressAccessModified: x.addressAccess === undefined ? [] : x.addressAccess.map((addr) => ({
						address: addr.address,
						access: addr.access,
						removed: false,
					})),
					access: x.access,
					removed: false,
				}))
			}
			// update only the changed entities
			const merge = (newAccess: WebsiteAccess) => {
				const previousEntity = editableAccessList.find((x) => x.websiteAccess.website.websiteOrigin === newAccess.website.websiteOrigin)
				if (previousEntity === undefined) {
					return {
						websiteAccess: newAccess,
						addressAccess: newAccess.addressAccess === undefined ? [] : newAccess.addressAccess,
						addressAccessModified: newAccess.addressAccess === undefined ? [] : newAccess.addressAccess.map((addr) => ({
							address: addr.address,
							access: addr.access,
							removed: false,
						})),
						access: newAccess.access,
						removed: false,
					}
				}
				// we need to merge edited and new updated access rights together
				const mergeAddressAccess = (addr: WebsiteAddressAccess, modifiedAddressAccess: readonly ModifiedAddressAccess[], previousEntity: readonly WebsiteAddressAccess[]) => {
					const previousModifiedAccess = modifiedAddressAccess.find((x) => x.address === addr.address)
					const previousAccess = previousEntity.find((x) => x.address === addr.address)
					return {
						address: addr.address,
						access: previousModifiedAccess === undefined || previousAccess === undefined ? addr.access : (previousModifiedAccess.access === previousAccess.access ? addr.access : previousModifiedAccess.access),
						removed: previousModifiedAccess === undefined ? false : previousModifiedAccess.removed,
					}
				}

				const addressAccessModified = newAccess.addressAccess === undefined ? [] : newAccess.addressAccess.map((addr) => mergeAddressAccess(addr, previousEntity.addressAccessModified, previousEntity.addressAccess))
				return {
					...previousEntity,
					websiteAccess: newAccess,
					addressAccess: newAccess.addressAccess === undefined ? [] : newAccess.addressAccess,
					addressAccessModified: addressAccessModified,
					access: previousEntity.access === previousEntity.websiteAccess.access ? newAccess.access : previousEntity.access
				}
			}
			return newList.map((x) => merge(x))
		})
	}

	useEffect( () => {
		updateEditableAccessList(param.websiteAccess)
	}, [param.websiteAccess])

	useEffect( () => {
		setMetadata(new Map(param.websiteAccessAddressMetadata.map((x) => [addressString(x.address), x])))
	}, [param.websiteAccessAddressMetadata])

	function goHome() {
		param.setAndSaveAppPage('Home')
	}

	function setWebsiteAccess(index: number, access: boolean | undefined, removed: boolean | undefined) {
		if (editableAccessList === undefined) return
		setEditableAccessList(editableAccessList.map((x , i) => {
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
		setEditableAccessList(editableAccessList.map((x , i) => {
			if(index === i ) {
				return {
					websiteAccess: x.websiteAccess,
					addressAccess: x.addressAccess,
					addressAccessModified: x.addressAccessModified.map((addr, addrIndex) => ({
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
		for (const [index, access] of state.addressAccessModified.entries()) {
			if (access.removed || state.addressAccess[index].access !== access.access) {
				return true
			}
		}
		return false
	}
	function areThereChanges() {
		if (editableAccessList === undefined) return false
		for (const state of editableAccessList) {
			if (hasChanged(state)) return true
		}
		return false
	}

	function saveChanges() {
		if (!areThereChanges()) return goHome()
		if (editableAccessList === undefined) return goHome()

		const withoutRemovedEntries = editableAccessList.filter( (state) => !state.removed )
		const newEntries = withoutRemovedEntries.map((x) => ({
			website: x.websiteAccess.website,
			access: x.access,
			addressAccess: x.addressAccessModified.filter((x) => !x.removed ).map( (addr) => ({
				address: BigInt(addr.address),
				access: addr.access,
			})),
		}))
		sendPopupMessageToBackgroundPage( { method: 'popup_changeInterceptorAccess', options: newEntries } )
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
							{ access.removed ? <p style = 'color: var(--negative-color)' > { `Forgot ${ access.websiteAccess.website.websiteOrigin }. `}</p> :
								<div class = 'card'>
									<div class = 'card-header'>
										<div class = 'card-header-icon unset-cursor' >
											<p class = 'image is-24x24'>
												<img src = { access.websiteAccess.website.icon === undefined ? '../../img/question-mark-sign.svg' : access.websiteAccess.website.icon }/>
											</p>
										</div>
										<p class = 'card-header-title' style = 'width: 13em'>
											<CopyToClipboard
												content = { access.websiteAccess.website.websiteOrigin }
												copyMessage = 'Website address copied!'
											>
												<p className = 'paragraph noselect nopointer' style = 'text-overflow: ellipsis; overflow: hidden; white-space: nowrap; display: block; width: 13em'>
													{ access.websiteAccess.website.websiteOrigin }
												</p>
											</CopyToClipboard>
										</p>
										<div class = 'card-header-icon unset-cursor'>
											<label class = 'form-control' style = 'width: 8em;'>
												<input type = 'checkbox' checked = { access.access } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setWebsiteAccess(accessListIndex, e.target.checked, undefined) } } } />
												<p class = 'paragraph checkbox-text'>Allow access</p>
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
													{ websiteAccessAddress.removed ? <p style = 'color: var(--negative-color)' > { `Forgot ${ checksummedAddress(websiteAccessAddress.address) }`} </p> :
														<div style = 'display: flex; width: 100%; overflow: hidden;'>
															<SmallAddress
																addressBookEntry = { metadata.get(addressString(websiteAccessAddress.address)) || {
																	type: 'addressInfo',
																	name: checksummedAddress(websiteAccessAddress.address),
																	address: BigInt(websiteAccessAddress.address),
																	askForAddressAccess: false
																}}
																renameAddressCallBack = { param.renameAddressCallBack }
															/>
															<div style = 'margin-left: auto; flex-shrink: 0; display: flex'>
																<label class = 'form-control' style = 'margin: auto'>
																	<input type = 'checkbox' checked = { websiteAccessAddress.access } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAddressAccess(accessListIndex, addressIndex, e.target.checked, undefined) } } } />
																	<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'>Allow access</p>
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
