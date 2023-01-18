import Blockies from '../subcomponents/PreactBlocky.js'
import { AddressInfo, AddressListParams, Page } from '../../utils/user-interface-types.js'
import { addressString } from '../../utils/bigint.js'
import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { Notice } from '../subcomponents/Error.js'
import { getIssueWithAddressString } from '../ui-utils.js'

interface AddressInfoTemporaryState {
	originalAddressInfo: AddressInfo,
	nameAttempt: string,
	addressAttempt: string,
	askForAddressAccess: boolean,
	removed: boolean,
}

export function AddressList(param: AddressListParams) {
	const [addressInfoTemporaryState, setAddressInfoTemporaryState] = useState<AddressInfoTemporaryState[] | undefined>(undefined)
	const [errorString, setErrorString] = useState<string | undefined>(undefined)

	function updateAddressInfos(infos: AddressInfo[] | undefined = undefined) {
		const newInfos = infos ? infos : param.addressInfos
		const newTempState = newInfos.map( (x) => ({
			originalAddressInfo: x,
			nameAttempt: x.name,
			addressAttempt: ethers.utils.getAddress(addressString(x.address)),
			askForAddressAccess: x.askForAddressAccess,
			removed: false,
		}))
		setAddressInfoTemporaryState(newTempState)
		setErrorString(getErrorMessage(newTempState))
	}

	useEffect( () => {
		updateAddressInfos()
	}, [])

	useEffect( () => {
		updateAddressInfos()
	}, [param.addressInfos])

	function changePageToAddAddress() {
		param.setAndSaveAppPage(Page.AddNewAddress)
	}

	function goHome() {
		param.setAndSaveAppPage(Page.Home)
	}

	function changeAddressInfoState(index: number, newState: AddressInfoTemporaryState) {
		if (addressInfoTemporaryState === undefined) return
		const newTempState = addressInfoTemporaryState.map( (x , i) => {
			if(index === i ) return newState
			return x
		})
		setAddressInfoTemporaryState(newTempState)
		setErrorString(getErrorMessage(newTempState))
	}

	function changeAddress(index: number, addressAttempt: string) {
		if( addressInfoTemporaryState === undefined) return
		const currentState = addressInfoTemporaryState[index]
		changeAddressInfoState(index, { ...currentState, addressAttempt: addressAttempt } )
	}

	function changeName(index: number, nameAttempt: string) {
		if( addressInfoTemporaryState === undefined) return
		const currentState = addressInfoTemporaryState[index]
		changeAddressInfoState(index, { ...currentState, nameAttempt: nameAttempt } )
	}

	function changeAskForAddressAccess(index: number, askForAddressAccess: boolean) {
		if( addressInfoTemporaryState === undefined) return
		const currentState = addressInfoTemporaryState[index]
		changeAddressInfoState(index, { ...currentState, askForAddressAccess: askForAddressAccess } )
	}

	function remove(index: number) {
		if( addressInfoTemporaryState === undefined) return
		const currentState = addressInfoTemporaryState[index]
		changeAddressInfoState(index, { ...currentState, removed: true } )
	}

	function areValidChanges(state: AddressInfoTemporaryState) {
		if (state.removed) return true
		if (!ethers.utils.isAddress(state.addressAttempt.trim())) return false
		if (state.nameAttempt.length > 42) return false
		return true
	}
	function hasChanged(state: AddressInfoTemporaryState) {
		if (!ethers.utils.isAddress(state.addressAttempt.trim())) return true

		return BigInt(state.addressAttempt.trim()) !== state.originalAddressInfo.address
			|| state.nameAttempt !== state.originalAddressInfo.name
			|| state.removed
			|| state.askForAddressAccess !== state.originalAddressInfo.askForAddressAccess
	}
	function areThereChanges(newState: AddressInfoTemporaryState[] | undefined) {
		if (newState === undefined) return false
		for (const state of newState) {
			if ( hasChanged(state) ) return true
		}

		return false
	}
	function areChangesValid(newState: AddressInfoTemporaryState[] | undefined) {
		if (newState === undefined) return true
		for (const state of newState) {
			if ( !areValidChanges(state) ) return false
		}

		return true
	}
	function getErrorMessage(newState: AddressInfoTemporaryState[] | undefined) {
		if (newState === undefined) return undefined
		if (areChangesValid(newState)) return undefined
		let nErrors = 0
		let errorString: string | undefined = ''
		for (const state of newState) {
			if ( areValidChanges(state) ) continue
			nErrors++
			if (nErrors !== 1 ) continue
			if (state.nameAttempt.length > 42) {
				errorString = 'Too long name.'
				continue
			}
			const issue = getIssueWithAddressString(state.addressAttempt)
			errorString = issue === undefined ? 'Unknown issue.' : issue
		}
		if ( nErrors === 0) return undefined

		if (errorString === undefined) {
			return `Unknown issue and ${ nErrors > 1 ? ` (${ nErrors - 1} other issue${ nErrors > 2 ? 's' : '' })` : '' }`
		}
		return `${ errorString } ${ nErrors > 1 ? ` (${ nErrors - 1} other issues${ nErrors > 2 ? 's' : '' })` : '' }`
	}

	function saveChanges(newState: AddressInfoTemporaryState[] | undefined) {
		if (!areChangesValid(newState)) return goHome()
		if (!areThereChanges(newState)) return goHome()
		if (newState === undefined) return goHome()

		const withoutRemovedEntries = newState.filter( (state) => !state.removed )
		const newAddressInfos = withoutRemovedEntries.map( (x) => ({
			name: x.nameAttempt,
			address: BigInt(x.addressAttempt),
			askForAddressAccess: x.askForAddressAccess,
		}))
		browser.runtime.sendMessage( { method: "popup_changeAddressInfos", options: newAddressInfos.map( (x) => AddressInfo.serialize(x) ) } )
		updateAddressInfos(newAddressInfos)
		param.setAddressInfos(newAddressInfos)
		return goHome()
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card' style = 'height: 100%;'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'>
					Address Book
					</p>
				</p>
				<button class='card-header-icon' aria-label='close' onClick = { goHome }>
					<span class='icon' style = 'color:var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body'>
				<ul>
					{ addressInfoTemporaryState === undefined ? <></> : addressInfoTemporaryState.map( (temporaryAddressInfoState, addressInfoIndex) => (
						<li>
							{ temporaryAddressInfoState.removed ? <p style = 'color: var(--negative-color)' > Removed </p> :
								<div class = 'card'>
									<div class = 'card-content'>
										<div class = 'media'>
											<div class = 'media-left'>
												<figure class = 'image'>
													<Blockies seed = { ethers.utils.isAddress(temporaryAddressInfoState.addressAttempt.trim()) ? temporaryAddressInfoState.addressAttempt.trim().toLowerCase() : addressString(temporaryAddressInfoState.originalAddressInfo.address).toLowerCase() } size = { 8 } scale = { 5 } />
												</figure>
											</div>

											<div class = 'media-content' style = 'overflow-y: visible; overflow-x: unset;'>
												<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
													<div className = 'control is-expanded'>
														<input className = 'input' type = 'text' value = { temporaryAddressInfoState.nameAttempt }
															onInput = { e => changeName(addressInfoIndex, (e.target as HTMLInputElement).value) }
															style = 'overflow: visible;'
															maxLength = { 42 }/>
													</div>
												</div>
												<div className = 'field is-grouped' style = 'margin-bottom: 0px'>
													<div className = 'control is-expanded'>
														<input className = 'input' type = 'text' value = { temporaryAddressInfoState.addressAttempt }
															onInput = { e => changeAddress(addressInfoIndex, (e.target as HTMLInputElement).value) }
															style = { `overflow: visible; color: ${ ethers.utils.isAddress(temporaryAddressInfoState.addressAttempt.trim()) ? 'var(--text-color)' : 'var(--negative-color)' };` } />
													</div>
												</div>
												<label class = 'form-control'>
													<input type = 'checkbox' checked = { !temporaryAddressInfoState.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { changeAskForAddressAccess(addressInfoIndex, !e.target.checked) } } } />
													Don't request for an access (unsecure)
												</label>
											</div>

											<div class = 'content' style = 'color: var(--text-color);'>
												<button class = 'card-header-icon' style = 'padding: 0px;' aria-label = 'delete' onClick = { () => remove(addressInfoIndex) }>
													<span class = 'icon' style = 'color: var(--text-color);'> X </span>
												</button>
											</div>
										</div>
									</div>
								</div>
							}
						</li>
					) ) }
				</ul>
			</section>

			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>

				{ errorString === undefined ? <></> :
					<div style = 'padding-bottom: 0.5em;'>
						<Notice text = { errorString }/>
					</div>
				}

				<button class = 'button is-success is-primary' onClick = { () => saveChanges(addressInfoTemporaryState) } disabled = { ! (areChangesValid(addressInfoTemporaryState)) }> { areThereChanges(addressInfoTemporaryState) ? 'Save & Close' : 'Close' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { goHome }>Cancel</button>
				<button class = 'button is-primary' onClick = { changePageToAddAddress } >Add New Address</button>
			</footer>
		</div>
	</> )
}
