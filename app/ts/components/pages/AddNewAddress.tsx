import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { AddAddressParam } from '../../utils/user-interface-types.js'
import { Notice } from '../subcomponents/Error.js'
import { getIssueWithAddressString } from '../ui-utils.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable } from '../../utils/typescript.js'
import { ComponentChildren, createRef } from 'preact'
import { AddressBookEntry, InCompleteAddressBookEntry } from '../../utils/addressBookTypes.js'

const readableAddressType = {
	'contact': 'Contact',
	'addressInfo': 'Active Address',
	'ERC20': 'ERC20',
	'ERC721': 'ERC721',
	'ERC1155': 'ERC1155',
	'contract': 'contract',
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
	setNameInput: (input: string) => void
	disabled: boolean,
}

export function NameInput({ nameInput, setNameInput, disabled }: NameInputParams) {
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
		style = { 'width: 100%' }
		disabled = { disabled }
	/>
}

type AddressInputParams = {
	disabled: boolean
	addressInput: string | undefined
	setAddress: (input: string) => void
}

export function AddressInput({ disabled, addressInput, setAddress }: AddressInputParams) {
	return <input
		disabled = { disabled }
		className = 'input subtitle is-7 is-spaced'
		type = 'text'
		value = { addressInput }
		placeholder = { '0x0...' }
		onInput = { e => setAddress((e.target as HTMLInputElement).value) }
		style = { `width: 100%;${ addressInput === undefined || ethers.isAddress(addressInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

type RenderInCompleteAddressBookParams = {
	inCompleteAddressBookEntry: InCompleteAddressBookEntry,
	setName: (name: string) => void,
	setAddress: (name: string) => void,
	setAskForAddressAccess: (name: boolean) => void,
}

export const CellElement = (param: { element: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		{ param.element }
	</div>
}

<p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width:100%'></p>

function RenderInCompleteAddressBookEntry({ inCompleteAddressBookEntry, setName, setAddress, setAskForAddressAccess }: RenderInCompleteAddressBookParams) {
	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width:100%'>
			{ param.text }
		</p>
	}
	const disableDueToSource = inCompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || inCompleteAddressBookEntry.entrySource === 'Interceptor'
	const logoUri = inCompleteAddressBookEntry.addingAddress === false && 'logoUri' in inCompleteAddressBookEntry ? inCompleteAddressBookEntry.logoUri : undefined
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { inCompleteAddressBookEntry.address } logoUri = { logoUri }/>
			</figure>
		</div>
		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<div class = 'container' style = 'margin-bottom: 10px;'>
				<span class = 'log-table' style = 'justify-content: left; column-gap: 5px; row-gap: 5px; grid-template-columns: max-content 400px;'>
					<CellElement element = { <Text text = { 'Name: ' }/> }/>
					<CellElement element = { <NameInput nameInput = { inCompleteAddressBookEntry.name } setNameInput = { setName } disabled = { disableDueToSource }/> } />
					<CellElement element = { <Text text = { 'Address: ' }/> }/> 
					<CellElement element = { <AddressInput disabled = { inCompleteAddressBookEntry.addingAddress === false || disableDueToSource } addressInput = { inCompleteAddressBookEntry.address } setAddress = { setAddress } /> } />
					{ inCompleteAddressBookEntry.type === 'ERC20' || inCompleteAddressBookEntry.type === 'ERC1155' ? <>
						<CellElement element = { <Text text = { 'Symbol: ' }/> }/>
						<CellElement element = { <input disabled = { true } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { inCompleteAddressBookEntry.symbol } placeholder = { '...' } /> } />
					</> : <></> }
					{ inCompleteAddressBookEntry.type === 'ERC20' ? <>
						<CellElement element = { <Text text = { 'Decimals: ' }/> }/>
						<CellElement element = { <input disabled = { true } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { inCompleteAddressBookEntry.decimals !== undefined ? inCompleteAddressBookEntry.decimals.toString() : inCompleteAddressBookEntry.decimals } placeholder = { '...' } /> } />
					</> : <></> }
				</span>
			</div>
			{ inCompleteAddressBookEntry.type === 'addressInfo' ? <>
				<label class = 'form-control'>
					<input type = 'checkbox'  disabled = { disableDueToSource } checked = { !inCompleteAddressBookEntry.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
					<p class = 'paragraph checkbox-text'>Don't request for an access (insecure)</p>
				</label>
			</> : <></> }
		</div>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const [errorString, setErrorString] = useState<string | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
	const [inCompleteAddressBookEntry, setInCompleteAddressBookEntry] = useState<InCompleteAddressBookEntry>({ addingAddress: false, type: 'addressInfo', address: undefined, askForAddressAccess: false, name: undefined, symbol: undefined, decimals: undefined, logoUri: undefined, entrySource: 'FilledIn' })

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

	async function add() {
		param.close()
		const entryToAdd = getCompleteAddressBookEntry()
		if (entryToAdd === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd } )
		setInCompleteAddressBookEntry({ addingAddress: false, type: 'addressInfo', address: undefined, askForAddressAccess: false, name: undefined, symbol: undefined, decimals: undefined, logoUri: undefined, entrySource: 'FilledIn' })
	}

	async function createAndSwitch() {
		const inputedAddressBigInt = stringToAddress(inCompleteAddressBookEntry?.address)
		if (inputedAddressBigInt === undefined) return
		await add()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}
/*
	function identifyAddress(address: bigint) {
		sendPopupMessageToBackgroundPage({ method: 'popup_identifyAddress', data: { address } })
	}*/

	useEffect(() => {
		setInCompleteAddressBookEntry(param.inCompleteAddressBookEntry)
		setActiveAddress(param.activeAddress)
		if (param.inCompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || param.inCompleteAddressBookEntry.entrySource === 'Interceptor') {
			setErrorString(`The address information for ${ param.inCompleteAddressBookEntry.name } originates from The Interceptor and cannot be modified.`)
		} else {
			setErrorString(undefined)
		}
	}, [param.inCompleteAddressBookEntry, param.activeAddress])

	function areInputValid() {
		return getCompleteAddressBookEntry() !== undefined
	}

	function setAddress(input: string) {
		setInCompleteAddressBookEntry((prevEntry) => {
			if (input === undefined) {
				setErrorString(undefined)
				return { ... prevEntry, address: input }
			}
			const trimmed = input.trim()
			if (ethers.isAddress(trimmed)) {
				setErrorString(undefined)
				return { ... prevEntry, address: input }
			}

			const issue = getIssueWithAddressString(trimmed)
			if (issue === undefined) {
				setErrorString('Unknown issue.')
				return { ... prevEntry, address: input }
			}
			setErrorString(`${ issue }`)
			return { ... prevEntry, address: input }
		})
	}

	function setName(name: string) {
		setInCompleteAddressBookEntry((entry) => {
			if (entry === undefined) return entry
			return { ...entry, name }
		})
	}
	function setAskForAddressAccess(askForAddressAccess: boolean) {
		setInCompleteAddressBookEntry((entry) => {
			if (entry === undefined) return entry
			return { ...entry, askForAddressAccess }
		})
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
					<p className = 'paragraph'> { param.inCompleteAddressBookEntry.addingAddress ? `Add New ${ readableAddressType[param.inCompleteAddressBookEntry.type] }` : `Modify ${ param.inCompleteAddressBookEntry.name !== undefined ? param.inCompleteAddressBookEntry.name : readableAddressType[param.inCompleteAddressBookEntry.type] }` } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<RenderInCompleteAddressBookEntry
							inCompleteAddressBookEntry = { inCompleteAddressBookEntry }
							setAddress = { setAddress }
							setName = { setName }
							setAskForAddressAccess = { setAskForAddressAccess }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; height: 50px'>
					{ errorString === undefined ? <></> : <Notice text = { errorString } /> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || inCompleteAddressBookEntry === undefined || activeAddress === stringToAddress(inCompleteAddressBookEntry.address) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { ! (areInputValid()) }> { param.inCompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { add } disabled = { !areInputValid() || param.inCompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || param.inCompleteAddressBookEntry.entrySource === 'Interceptor' }> { param.inCompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
