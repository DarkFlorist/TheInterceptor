import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { EthereumAddress } from '../../utils/wire-types.js'
import { AddAddressParam, AddressBookEntry } from '../../utils/user-interface-types.js'
import Blockie from '../subcomponents/PreactBlocky.js'
import { Notice } from '../subcomponents/Error.js'
import { getIssueWithAddressString } from '../ui-utils.js'
import { addressString } from '../../utils/bigint.js'

export function AddNewAddress(param: AddAddressParam) {
	const [addressInput, setAddressInput] = useState<string | undefined>(undefined)
	const [nameInput, setNameInput] = useState<string | undefined>(undefined)
	const [askForAddressAccess, setAskForAddressAccess] = useState<boolean>(true)
	const [errorString, setErrorString] = useState<string | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
	const [addresBookEntryInput, setAddressBookEntryInput] = useState<AddressBookEntry | undefined>(undefined)
	const [addressType, setAddressType] = useState<'contact' | 'addressInfo' | 'token' | 'NFT' | 'other contract'>('addressInfo')

	function add() {
		if (addressInput === undefined) return
		if (!areInputValid()) return
		param.close()
		const newEntry = {
			...addresBookEntryInput,
			name: nameInput ? nameInput: ethers.utils.getAddress(addressInput),
			address: EthereumAddress.serialize(BigInt(addressInput)),
			askForAddressAccess: askForAddressAccess,
		}
		browser.runtime.sendMessage( { method: 'popup_addOrModifyAddressBookEntry', options: [newEntry] } )

		setAddress(undefined)
		setNameInput(undefined)
		setAskForAddressAccess(true)
	}

	function createAndSwitch() {
		if (addressInput === undefined) return
		if (!areInputValid()) return
		add()
		if (param.setActiveAddressAndInformAboutIt !== undefined) param.setActiveAddressAndInformAboutIt(BigInt(addressInput))
	}

	useEffect( () => {
		if (param.addressBookEntry !== undefined) {
			setAddressInput(ethers.utils.getAddress(addressString(param.addressBookEntry.address)))
			setNameInput(param.addressBookEntry.name)
			setAddressType(param.addressBookEntry.type)
			if (param.addressBookEntry.type === 'addressInfo') {
				setAskForAddressAccess(param.addressBookEntry.askForAddressAccess)
			}
		} else {
			setAddressType('addressInfo')
		}
		setAddressBookEntryInput(param.addressBookEntry)
		setActiveAddress(param.activeAddress)

	}, [param.addressBookEntry, param.activeAddress])

	function areInputValid() {
		if (addressInput === undefined) return false
		if (!ethers.utils.isAddress(addressInput)) return false
		if (nameInput !== undefined && nameInput.length > 42) return false
		return true
	}

	function setAddress(input: string | undefined) {
		setAddressInput(input)

		if (input === undefined) return setErrorString(undefined)

		if (ethers.utils.isAddress(input)) return setErrorString(undefined)

		const issue = getIssueWithAddressString(input)
		if (issue === undefined) return setErrorString('Unknown issue.')
		return setErrorString(`${ issue }`)
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'> { param.addingNewAddress ? 'Add New Address' : 'Edit Address' } </p>
				</p>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						{ addressType !== 'addressInfo' ? <p class = 'paragraph'> { `No support to rename this address type yet 😢 (${ addressType })` } </p> :
							<div class = 'media'>
								<div class = 'media-left'>
									<figure class = 'image'>
										{ addressInput && ethers.utils.isAddress(addressInput.trim()) ?
											<Blockie seed = { addressInput.trim().toLowerCase() } size = { 8 } scale = { 5 } />
										: <div style = 'background-color: var(--unimportant-text-color); width: 40px; height: 40px; border-radius: 5px;'/> }
									</figure>
								</div>

								<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
									<input className = 'input' type = 'text' value = { nameInput } placeholder = { addressInput === undefined || addressInput === '' ? 'Name of the address' : addressInput }
										onInput = { e => setNameInput((e.target as HTMLInputElement).value) }
										maxLength = { 42 }
									/>
									<input disabled = { !param.addingNewAddress } className = 'input' type = 'text' value = { addressInput } placeholder = { '0x0...' }
										onInput = { e => setAddress((e.target as HTMLInputElement).value) }
										style = { `${ addressInput === undefined || ethers.utils.isAddress(addressInput.trim()) ? '' : 'color: var(--negative-color);' }` } />
									<label class = 'form-control'>
										<input type = 'checkbox' checked = { !askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
										Don't request for an access (unsecure)
									</label>
								</div>
							</div>
						}
					</div>
				</div>
				<div style = 'padding: 10px; height: 50px'>
					{ errorString === undefined ? <></> : <Notice text = { errorString } /> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || addressInput === undefined || activeAddress === BigInt(addressInput) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { ! (areInputValid()) }> { param.addingNewAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { add } disabled = { ! (areInputValid()) }> { param.addingNewAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )

}
