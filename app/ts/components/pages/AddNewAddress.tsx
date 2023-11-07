import { ethers } from 'ethers'
import { StateUpdater, useEffect, useState } from 'preact/hooks'
import { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, Notice } from '../subcomponents/Error.js'
import { getIssueWithAddressString } from '../ui-utils.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable } from '../../utils/typescript.js'
import { ComponentChildren, createRef } from 'preact'
import { AddressBookEntry, IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import { ExternalPopupMessage } from '../../types/interceptor-messages.js'
import { isJSON } from '../../utils/json.js'
import { isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'

const readableAddressType = {
	'contact': 'Contact',
	'activeAddress': 'Active Address',
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

type RenderinCompleteAddressBookParams = {
	incompleteAddressBookEntry: IncompleteAddressBookEntry
	setName: (name: string) => void
	setAddress: (address: string) => void
	setSymbol: (symbol: string) => void
	setAskForAddressAccess: (name: boolean) => void
	fetchAbiAndNameFromEtherscan: (address: string | undefined) => void
	setAbi: (abi: string) => void
	retrievedAbi: boolean
	setRetrievingAbi: StateUpdater<boolean>
}

export const CellElement = (param: { element: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		{ param.element }
	</div>
}

type AbiInputParams = {
	abiInput: string | undefined
	setAbiInput: (input: string) => void
	disabled: boolean,
}

function AbiInput({ abiInput, setAbiInput, disabled }: AbiInputParams) {
	const ref = createRef<HTMLInputElement>()
    useEffect(() => { ref.current && ref.current.focus() }, [])
	return <input
		className = 'input is-spaced'
		type = 'text'
		value = { abiInput }
		placeholder = { 'not available / not retrieved' }
		onInput = { e => setAbiInput(e.currentTarget.value) }
		ref = { ref }
		disabled = { disabled }
		style = { `width: 100%;${ abiInput === undefined || isValidAbi(abiInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

function RenderIncompleteAddressBookEntry({ incompleteAddressBookEntry, setName, setAddress, setSymbol, setAskForAddressAccess, fetchAbiAndNameFromEtherscan, setAbi, retrievedAbi, setRetrievingAbi }: RenderinCompleteAddressBookParams) {
	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width:100%'>
			{ param.text }
		</p>
	}
	const disableDueToSource = incompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || incompleteAddressBookEntry.entrySource === 'Interceptor'
	const logoUri = incompleteAddressBookEntry.addingAddress === false && 'logoUri' in incompleteAddressBookEntry ? incompleteAddressBookEntry.logoUri : undefined
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { incompleteAddressBookEntry.address } logoUri = { logoUri }/>
			</figure>
		</div>
		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<div class = 'container' style = 'margin-bottom: 10px;'>
				<span class = 'log-table' style = 'column-gap: 5px; row-gap: 5px; grid-template-columns: max-content auto;'>
					<CellElement element = { <Text text = { 'Name: ' }/> }/>
					<CellElement element = { <NameInput nameInput = { incompleteAddressBookEntry.name } setNameInput = { setName } disabled = { disableDueToSource }/> } />
					<CellElement element = { <Text text = { 'Address: ' }/> }/> 
					<CellElement element = { <AddressInput disabled = { incompleteAddressBookEntry.addingAddress === false || disableDueToSource } addressInput = { incompleteAddressBookEntry.address } setAddress = { setAddress } /> } />
					{ incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC1155' ? <>
						<CellElement element = { <Text text = { 'Symbol: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { incompleteAddressBookEntry.symbol } placeholder = { '...' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setSymbol(e.target.value) } } } /> } />
					</> : <></> }
					{ incompleteAddressBookEntry.type === 'ERC20' ? <>
						<CellElement element = { <Text text = { 'Decimals: ' }/> }/>
						<CellElement element = { <input disabled = { true } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { incompleteAddressBookEntry.decimals !== undefined ? incompleteAddressBookEntry.decimals.toString() : incompleteAddressBookEntry.decimals } placeholder = { '...' } /> } />
					</> : <></> }
					{ incompleteAddressBookEntry.type !== 'activeAddress' ? <>
						<CellElement element = { <Text text = { 'Abi: ' }/> }/>
						<CellElement element = { <>
							<AbiInput abiInput = { incompleteAddressBookEntry.abi } setAbiInput = { setAbi } disabled = { false }/>
							<div style = 'padding-left: 5px'/>
							<button class = 'button is-primary is-small' disabled = { stringToAddress(incompleteAddressBookEntry.address) === undefined || retrievedAbi } onClick = { async  () => { setRetrievingAbi(true); fetchAbiAndNameFromEtherscan(incompleteAddressBookEntry.address) } }> Fetch from Etherscan</button>
						</> }/>
					</> : <></> }
				</span>
			</div>
			{ incompleteAddressBookEntry.type === 'activeAddress' ? <>
				<label class = 'form-control'>
					<input type = 'checkbox' disabled = { disableDueToSource } checked = { !incompleteAddressBookEntry.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
					<p class = 'paragraph checkbox-text'>Don't request for an access (insecure)</p>
				</label>
			</> : <></> }
			</div>
	</div>
}

type DuplicateCheck = {
	duplicateStatus: 'Pending'
} | {
	duplicateStatus: 'NoDuplicates'
} | {
	duplicateStatus: 'Duplicates'
	duplicateEntry: AddressBookEntry
}

export function AddNewAddress(param: AddAddressParam) {
	const [errorString, setErrorString] = useState<string | undefined>(undefined)
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
	const [incompleteAddressBookEntry, setIncompleteAddressBookEntry] = useState<IncompleteAddressBookEntry & DuplicateCheck>({ addingAddress: false, type: 'activeAddress', address: undefined, askForAddressAccess: false, name: undefined, symbol: undefined, decimals: undefined, logoUri: undefined, entrySource: 'FilledIn', duplicateStatus: 'NoDuplicates', abi: undefined })
	const [onChainInformationVerifiedByUser, setOnChainInformationVerifiedByUser] = useState<boolean>(false)
	const [retrievedAbi, setRetrievingAbi] = useState<boolean>(false)
	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const parsed = ExternalPopupMessage.parse(msg)
			if (parsed.method === 'popup_findAddressBookEntryWithSymbolOrNameReply') {
				setIncompleteAddressBookEntry((previous) => {
					if (parsed.data.query.name === previous.name && parsed.data.query.symbol === previous.symbol) { 
						if (parsed.data.addressBookEntryOrUndefined === undefined || parsed.data.addressBookEntryOrUndefined.address == stringToAddress(previous.address)) {
							return { ...previous, duplicateStatus: 'NoDuplicates' }
						}
						return { ...previous, duplicateStatus: 'Duplicates', duplicateEntry: parsed.data.addressBookEntryOrUndefined }
					}
					return previous
				})
			}
			if (parsed.method === 'popup_fetchAbiAndNameFromEtherscanReply') {
				setIncompleteAddressBookEntry((prevEntry) => {
					if (!parsed.data.success) {
						setErrorString(parsed.data.error)
						return prevEntry
					}
					setErrorString(undefined)
					if (parsed.data === undefined || parsed.data.address !== stringToAddress(prevEntry.address)) return prevEntry
					checkForDuplicatedNameOrSymbol(parsed.data.contractName, prevEntry.symbol)
					return { ...prevEntry, name: prevEntry.name === undefined ? parsed.data.contractName : prevEntry.name, abi: parsed.data.abi, duplicateStatus: 'Pending' }
				})
				return setRetrievingAbi(false)
			}
			if (parsed.method !== 'popup_identifyAddressReply') return
			return setIncompleteAddressBookEntry((prevEntry) => {
				if (parsed.data.addressBookEntry.address !== stringToAddress(prevEntry.address)) return prevEntry
				if (parsed.data.addressBookEntry.entrySource !== 'OnChain' && parsed.data.addressBookEntry.entrySource !== 'FilledIn') {
					setErrorString(`The address ${ checksummedAddress(parsed.data.addressBookEntry.address) } you are trying to add already exists. Edit the existing record instead trying to add it again.`)
					return prevEntry
				}
				if (parsed.data.addressBookEntry.type !== prevEntry.type && !(prevEntry.type === 'activeAddress' && parsed.data.addressBookEntry.type === 'contact') ) {
					setErrorString(`The address ${ checksummedAddress(parsed.data.addressBookEntry.address) } is a ${ parsed.data.addressBookEntry.type } while you are trying to add ${ prevEntry.type }.`)
					return prevEntry
				}
				return {
					...prevEntry,
					decimals: 'decimals' in parsed.data.addressBookEntry ? parsed.data.addressBookEntry.decimals : prevEntry.decimals,
					logoUri: 'logoUri' in parsed.data.addressBookEntry ? parsed.data.addressBookEntry.logoUri : prevEntry.logoUri,
					symbol: 'symbol' in parsed.data.addressBookEntry ? parsed.data.addressBookEntry.symbol : prevEntry.symbol,
				}
			})
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		}
	}, [])

	function getCompleteAddressBookEntry(): AddressBookEntry | undefined {
		if (incompleteAddressBookEntry.name !== undefined && incompleteAddressBookEntry.name.length > 42) return undefined
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return undefined
		const name = incompleteAddressBookEntry.name ? incompleteAddressBookEntry.name : checksummedAddress(inputedAddressBigInt)
		switch(incompleteAddressBookEntry.type) {
			case 'ERC721': {
				if (incompleteAddressBookEntry.symbol === undefined) return undefined
				return {
					type: 'ERC721' as const,
					name,
					address: inputedAddressBigInt,
					symbol: incompleteAddressBookEntry.symbol,
					logoUri: incompleteAddressBookEntry.logoUri,
					entrySource: 'User',
					abi: incompleteAddressBookEntry.abi,
				}
			}
			case 'ERC1155': {
				if (incompleteAddressBookEntry.symbol === undefined) return undefined
				return {
					type: 'ERC1155' as const,
					name,
					address: inputedAddressBigInt,
					symbol: incompleteAddressBookEntry.symbol,
					logoUri: incompleteAddressBookEntry.logoUri,
					decimals: undefined,
					entrySource: 'User',
					abi: incompleteAddressBookEntry.abi,
				}
			}
			case 'ERC20': {
				if (incompleteAddressBookEntry.symbol === undefined || incompleteAddressBookEntry.decimals === undefined) return undefined
				return {
					type: 'ERC20' as const,
					name,
					address: inputedAddressBigInt,
					symbol: incompleteAddressBookEntry.symbol,
					decimals: incompleteAddressBookEntry.decimals,
					logoUri: incompleteAddressBookEntry.logoUri,
					entrySource: 'User',
					abi: incompleteAddressBookEntry.abi,
				}
			}
			case 'contact':
			case 'contract': return {
				type: incompleteAddressBookEntry.type,
				name,
				address: inputedAddressBigInt,
				logoUri: incompleteAddressBookEntry.logoUri,
				entrySource: 'User',
				abi: incompleteAddressBookEntry.abi,
			}
			case 'activeAddress': {
				return {
					type: 'activeAddress' as const,
					name,
					address: inputedAddressBigInt,
					askForAddressAccess: incompleteAddressBookEntry.askForAddressAccess,
					entrySource: 'User',
				}
			}
			default: assertUnreachable(incompleteAddressBookEntry.type)
		}
	}

	async function add() {
		param.close()
		const entryToAdd = getCompleteAddressBookEntry()
		if (entryToAdd === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd } )
	}

	async function createAndSwitch() {
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry?.address)
		if (inputedAddressBigInt === undefined) return
		await add()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}

	useEffect(() => {
		setActiveAddress(param.activeAddress)
		setIncompleteAddressBookEntry((previous) => {
			if (param.incompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || param.incompleteAddressBookEntry.entrySource === 'Interceptor') {
				setErrorString(`The address information for ${ param.incompleteAddressBookEntry.name } originates from The Interceptor and cannot be modified.`)
			} else {
				setErrorString(undefined)
			}
			return { ...previous, ...param.incompleteAddressBookEntry }
		})
	}, [param.incompleteAddressBookEntry, param.activeAddress])

	function areInputValid() {
		return getCompleteAddressBookEntry() !== undefined
	}

	async function queryActiveAddressrmation(address: bigint | undefined) {
		if (address === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_identifyAddress', data: { address } })
	}
	async function checkForDuplicatedNameOrSymbol(name: string | undefined, symbol: string | undefined) {
		if (name === undefined && symbol === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_findAddressBookEntryWithSymbolOrName', data: { name, symbol } })
	}

	async function fetchAbiAndNameFromEtherscan(address: string | undefined) {
		const addr = stringToAddress(address)
		if (addr === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchAbiAndNameFromEtherscan', data: addr })
	}

	function setAddress(input: string) {
		setIncompleteAddressBookEntry((prevEntry) => {
			if (input === undefined) {
				setErrorString(undefined)
				return { ... prevEntry, address: input }
			}

			const trimmed = input.trim()

			if (ethers.isAddress(trimmed)) {
				queryActiveAddressrmation(stringToAddress(trimmed))
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
		setIncompleteAddressBookEntry((entry) => {
			checkForDuplicatedNameOrSymbol(name, entry.symbol)
			return { ...entry, name, duplicateStatus: 'Pending' }
		})
	}

	function setAbi(abi: string | undefined) {
		const trimmedAbi = abi === undefined ? undefined : abi.trim()
		setIncompleteAddressBookEntry((entry) => {
			if (trimmedAbi === undefined || trimmedAbi.length === 0) {
				setErrorString(undefined)
				return { ...entry, abi: undefined }
			}
			if (!isJSON(trimmedAbi)) {
				setErrorString('The Abi provided is not a JSON ABI. Please provide a valid JSON ABI.')
				return entry
			}

			if (!isValidAbi(trimmedAbi)) {
				setErrorString('The Abi provided  is not an ABI. Please provide a valid an ABI.')
				return entry
			}

			return { ...entry, abi: trimmedAbi }
		})
	}

	function setSymbol(symbol: string) {
		setIncompleteAddressBookEntry((entry) => {
			checkForDuplicatedNameOrSymbol(entry.name, symbol)
			return { ...entry, symbol, duplicateStatus: 'Pending'  }
		})
	}

	function setAskForAddressAccess(askForAddressAccess: boolean) {
		setIncompleteAddressBookEntry((entry) => {
			if (entry === undefined) return entry
			return { ...entry, askForAddressAccess }
		})
	}

	function showOnChainVerificationErrorBox() {
		return incompleteAddressBookEntry.entrySource === 'OnChain' && (incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC721')
	}

	function isSubmitButtonDisabled() {
		return !areInputValid()
			|| param.incompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' 
			|| param.incompleteAddressBookEntry.entrySource === 'Interceptor' 
			|| errorString !== undefined 
			|| incompleteAddressBookEntry.duplicateStatus === 'Duplicates'
			|| (showOnChainVerificationErrorBox() && !onChainInformationVerifiedByUser)
	}

	function getCardTitle() {
		if (param.incompleteAddressBookEntry.addingAddress) {
			return `Add New ${ readableAddressType[param.incompleteAddressBookEntry.type] }`
		}
		const alleged = showOnChainVerificationErrorBox() ? 'alleged ' : ''
		const name = param.incompleteAddressBookEntry.name !== undefined ? `${ alleged }${ param.incompleteAddressBookEntry.name }` : readableAddressType[param.incompleteAddressBookEntry.type]
		return `Modify ${ name }`
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
					<p className = 'paragraph'> { getCardTitle() } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<span class = 'icon' style = 'color: var(--text-color);'> X </span>
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<RenderIncompleteAddressBookEntry
							incompleteAddressBookEntry = { incompleteAddressBookEntry }
							setAddress = { setAddress }
							setName = { setName }
							setSymbol = { setSymbol }
							setAbi = { setAbi }
							setAskForAddressAccess = { setAskForAddressAccess }
							fetchAbiAndNameFromEtherscan = { fetchAbiAndNameFromEtherscan }
							retrievedAbi = { retrievedAbi }
							setRetrievingAbi = { setRetrievingAbi }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; height: 80px'>
					{ errorString === undefined ? <></> : <Notice text = { errorString } /> }
					{ errorString === undefined && incompleteAddressBookEntry.duplicateStatus === 'Duplicates' ? <>
						<Notice text = { `There already exists ${ incompleteAddressBookEntry.duplicateEntry.type === 'activeAddress' ? 'an address' : incompleteAddressBookEntry.duplicateEntry.type } with ${ 'symbol' in incompleteAddressBookEntry.duplicateEntry ? `symbol "${ incompleteAddressBookEntry.duplicateEntry.symbol }" and` : '' } name "${ incompleteAddressBookEntry.duplicateEntry.name }".` } />
						</> :
						( showOnChainVerificationErrorBox() ?
							<ErrorCheckBox
								text = { `The name and symbol are fetched directly from contract. This information can be WRONG and MALICIOUS, please check from the project of this token that the token address is correct.` }
								checked = { onChainInformationVerifiedByUser }
								onInput = { setOnChainInformationVerifiedByUser }
							/>
						: <></>)
					}
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || incompleteAddressBookEntry === undefined || activeAddress === stringToAddress(incompleteAddressBookEntry.address) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { ! (areInputValid()) }> { param.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { incompleteAddressBookEntry.duplicateStatus === 'Pending' ? () => {} : add } disabled = { isSubmitButtonDisabled() }> { param.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
