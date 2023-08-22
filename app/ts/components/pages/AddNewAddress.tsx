import { ethers } from 'ethers'
import { StateUpdater, useEffect, useState } from 'preact/hooks'
import { AddAddressParam, AddressBookEntryCategory } from '../../utils/user-interface-types.js'
import { Notice } from '../subcomponents/Error.js'
import { getIssueWithAddressString } from '../ui-utils.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable } from '../../utils/typescript.js'
import { createRef } from 'preact'

const readableAddressType = {
	'contact': 'Contact',
	'addressInfo': 'Active Address',
	'ERC20': 'ERC20',
	'ERC721': 'ERC721',
	'ERC1155': 'ERC1155',
	'other contract': 'Other Contract',
}

type IncompleteAddressIconParams = {
	addressInput: string | undefined,
	logoUri: string | undefined,
}

export function IncompleteAddressIcon({ addressInput, logoUri }: IncompleteAddressIconParams) {
	return <AddressIcon
		address = { stringToAddress(addressInput) }
		logoUri = { logoUri }
		isBig = { true }
		backgroundColor = { 'var(--text-color)' }
	/>
}

type NameInputParams = {
	nameInput: string | undefined
	setNameInput: StateUpdater<string | undefined>
}

export function NameInput({ nameInput, setNameInput }: NameInputParams) {
	const ref = createRef<HTMLInputElement>()
    useEffect(() => { ref.current && ref.current.focus() }, [])
	return <input
		className = 'input title is-5 is-spaced'
		type = 'text'
		value = { nameInput }
		placeholder = { 'What should we call this address?' }
		onInput = { e => setNameInput((e.target as HTMLInputElement).value) }
		maxLength = { 42 }
		ref = { ref }
	/>
}

type AddressInputParams = {
	disableAddress: boolean
	addressInput: string | undefined
	setAddress: (input: string | undefined) => void
}

export function AddressInput({ disableAddress, addressInput, setAddress }: AddressInputParams) {
	return <input
		disabled = { disableAddress }
		className = 'input subtitle is-7 is-spaced'
		type = 'text'
		value = { addressInput }
		placeholder = { '0x0...' }
		onInput = { e => setAddress((e.target as HTMLInputElement).value) }
		style = { `${ addressInput === undefined || ethers.isAddress(addressInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

type AddressInfoFieldsParams = {
	addressInput: string | undefined
	nameInput: string | undefined
	askForAddressAccess: boolean
	setNameInput: StateUpdater<string | undefined>
	setAddress: (input: string | undefined) => void
	setAskForAddressAccess: StateUpdater<boolean>
	disableAddress: boolean
	logoUri: string | undefined
}

export function AddressInfoFields({ addressInput, nameInput, setNameInput, setAddress, disableAddress, askForAddressAccess, setAskForAddressAccess, logoUri }: AddressInfoFieldsParams ) {
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { addressInput } logoUri = { logoUri }/>
			</figure>
		</div>

		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<NameInput nameInput = { nameInput } setNameInput = { setNameInput } />
			<AddressInput disableAddress = { disableAddress } addressInput = { addressInput } setAddress = { setAddress } />
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { !askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Don't request for an access (insecure)</p>
			</label>
		</div>
	</div>
}

type ContactFieldsParams = {
	addressInput: string | undefined
	nameInput: string | undefined
	setNameInput: StateUpdater<string | undefined>
	setAddress: (input: string | undefined) => void
	disableAddress: boolean
	logoUri: string | undefined
}

export function ContactFields({ addressInput, nameInput, setNameInput, setAddress, disableAddress, logoUri } : ContactFieldsParams ) {
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { addressInput } logoUri = { logoUri }/>
			</figure>
		</div>

		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<NameInput nameInput = { nameInput } setNameInput = { setNameInput } />
			<AddressInput disableAddress = { disableAddress } addressInput = { addressInput } setAddress = { setAddress } />
		</div>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const [addressInput, setAddressInput] = useState<string | undefined>(undefined)
	const [nameInput, setNameInput] = useState<string | undefined>(undefined)
	const [askForAddressAccess, setAskForAddressAccess] = useState<boolean>(true)
	const [errorString, setErrorString] = useState<string | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
<<<<<<< Updated upstream
	const [addressType, setAddressType] = useState<AddressBookEntryCategory>('addressInfo')
=======
	const [inCompleteAddressBookEntry, setInCompleteAddressBookEntry] = useState<InCompleteAddressBookEntry>({ addingAddress: false, type: 'addressInfo', address: undefined, askForAddressAccess: false, name: undefined, symbol: undefined, decimals: undefined, logoUri: undefined })

	function getCompleteAddressBookEntry(): AddressBookEntry | undefined {
		if (inCompleteAddressBookEntry.name !== undefined && inCompleteAddressBookEntry.name.length > 42) return undefined
		const inputedAddressBigInt = stringToAddress(inCompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return undefined
		const name = inCompleteAddressBookEntry.name ? inCompleteAddressBookEntry.name : checksummedAddress(inputedAddressBigInt)
		switch(inCompleteAddressBookEntry.type) {
			case 'ERC721': {
				if (inCompleteAddressBookEntry.symbol === undefined) return undefined
				return {
					type: 'ERC721' as const,
					name,
					address: inputedAddressBigInt,
					symbol: inCompleteAddressBookEntry.symbol,
					logoUri: inCompleteAddressBookEntry.logoUri,
					entrySource: 'User',
				}
			}
			case 'ERC1155': {
				if (inCompleteAddressBookEntry.symbol === undefined) return undefined
				return {
					type: 'ERC1155' as const,
					name,
					address: inputedAddressBigInt,
					symbol: inCompleteAddressBookEntry.symbol,
					logoUri: inCompleteAddressBookEntry.logoUri,
					decimals: undefined,
					entrySource: 'User',
				}
			}
			case 'ERC20': {
				if (inCompleteAddressBookEntry.symbol === undefined || inCompleteAddressBookEntry.decimals === undefined) return undefined
				return {
					type: 'ERC20' as const,
					name,
					address: inputedAddressBigInt,
					symbol: inCompleteAddressBookEntry.symbol,
					decimals: inCompleteAddressBookEntry.decimals,
					logoUri: inCompleteAddressBookEntry.logoUri,
					entrySource: 'User',
				}
			}
			case 'contact':
			case 'contract': return {
				type: inCompleteAddressBookEntry.type,
				name,
				address: inputedAddressBigInt,
				logoUri: inCompleteAddressBookEntry.logoUri,
				entrySource: 'User',
			}
			case 'addressInfo': {
				return {
					type: 'addressInfo' as const,
					name,
					address: inputedAddressBigInt,
					askForAddressAccess: inCompleteAddressBookEntry.askForAddressAccess,
					entrySource: 'User',
				}
			}
			default: assertUnreachable(inCompleteAddressBookEntry.type)
		}
	}
>>>>>>> Stashed changes

	async function add() {
		const inputedAddressBigInt = stringToAddress(addressInput)
		if (inputedAddressBigInt === undefined) return
		if (!areInputValid()) return

		param.close()
		switch(addressType) {
			case 'ERC20':
			case 'ERC721':
			case 'ERC1155':
			case 'other contract': throw new Error(`not upported address type! ${ addressType }`)
			case 'contact': {
				await sendPopupMessageToBackgroundPage({
					method: 'popup_addOrModifyAddressBookEntry',
					data: {
						type: 'contact',
						name: nameInput ? nameInput : checksummedAddress(inputedAddressBigInt),
						address: inputedAddressBigInt,
					}
				} )
				break
			}
			case 'addressInfo': {
				await sendPopupMessageToBackgroundPage({
					method: 'popup_addOrModifyAddressBookEntry',
					data: {
						type: 'addressInfo',
						name: nameInput ? nameInput : checksummedAddress(inputedAddressBigInt),
						address: inputedAddressBigInt,
						askForAddressAccess: askForAddressAccess,
					}
				} )
				break
			}
			default: assertUnreachable(addressType)
		}

		setAddress(undefined)
		setNameInput(undefined)
		setAskForAddressAccess(true)
	}

	async function createAndSwitch() {
		const inputedAddressBigInt = stringToAddress(addressInput)
		if (inputedAddressBigInt === undefined) return
		await add()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}

	useEffect(() => {
		if (param.addingNewAddress.addingAddress === false) {
			const addressInput = checksummedAddress(param.addingNewAddress.entry.address)
			setAddressInput(addressInput)
			setNameInput(param.addingNewAddress.entry.name === addressInput ? undefined : param.addingNewAddress.entry.name)
			setAddressType(param.addingNewAddress.entry.type)
			if (param.addingNewAddress.entry.type === 'addressInfo') {
				setAskForAddressAccess(param.addingNewAddress.entry.askForAddressAccess)
			}
		} else {
			setAddressType(param.addingNewAddress.type)
		}
		setActiveAddress(param.activeAddress)

	}, [param.addingNewAddress, param.activeAddress])

	function areInputValid() {
		if (stringToAddress(addressInput) === undefined) return false
		if (nameInput !== undefined && nameInput.length > 42) return false
		return true
	}

	function setAddress(input: string | undefined) {
		setAddressInput(input)

		if (input === undefined) return setErrorString(undefined)
		const trimmed = input.trim()
		if (ethers.isAddress(trimmed)) return setErrorString(undefined)

		const issue = getIssueWithAddressString(trimmed)
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
				<div class = 'card-header-title'>
					<p className = 'paragraph'> { param.addingNewAddress.addingAddress ? `Add New ${ readableAddressType[param.addingNewAddress.type] }` : `Modify ${ readableAddressType[param.addingNewAddress.entry.type] }` } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						{ addressType === 'addressInfo' ?
							<AddressInfoFields
								addressInput = { addressInput }
								nameInput = { nameInput }
								askForAddressAccess = { askForAddressAccess }
								setNameInput = { setNameInput }
								setAddress = { setAddress }
								setAskForAddressAccess = { setAskForAddressAccess }
								disableAddress = { param.addingNewAddress.addingAddress === false }
								logoUri = { param.addingNewAddress.addingAddress === false && 'logoUri' in param.addingNewAddress.entry ? param.addingNewAddress.entry.logoUri : undefined }
							/>
						: <></> }

						{ addressType === 'contact' ?
							<ContactFields
								addressInput = { addressInput }
								nameInput = { nameInput }
								setNameInput = { setNameInput }
								setAddress = { setAddress }
								disableAddress = { param.addingNewAddress.addingAddress === false }
								logoUri = { param.addingNewAddress.addingAddress === false && 'logoUri' in param.addingNewAddress.entry ? param.addingNewAddress.entry.logoUri : undefined }
							/>
						: <></> }

						{ addressType !== 'contact' && addressType !== 'addressInfo' ?
							<p class = 'paragraph'> { `No support to rename this address type yet 😢 (${ addressType })` } </p>
						: <></> }
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; height: 50px'>
					{ errorString === undefined ? <></> : <Notice text = { errorString } /> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || addressInput === undefined || activeAddress === stringToAddress(addressInput) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { ! (areInputValid()) }> { param.addingNewAddress.addingAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { add } disabled = { ! (areInputValid()) }> { param.addingNewAddress.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
