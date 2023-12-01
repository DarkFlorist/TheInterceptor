import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, Notice } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable } from '../../utils/typescript.js'
import { ComponentChildren, createRef } from 'preact'
import { AddressBookEntry, IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import { ExternalPopupMessage } from '../../types/interceptor-messages.js'
import { isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import { ModifyAddressWindowState } from '../../types/visualizer-types.js'

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
	setAbi: (abi: string) => void
	canFetchFromEtherScan: boolean
	fetchAbiAndNameFromEtherscan: () => Promise<void>
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

function RenderIncompleteAddressBookEntry({ incompleteAddressBookEntry, setName, setAddress, setSymbol, setAskForAddressAccess, setAbi, canFetchFromEtherScan, fetchAbiAndNameFromEtherscan }: RenderinCompleteAddressBookParams) {
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
							<button class = 'button is-primary is-small' disabled = { stringToAddress(incompleteAddressBookEntry.address) === undefined || !canFetchFromEtherScan } onClick = { async  () => { fetchAbiAndNameFromEtherscan() } }> Fetch from Etherscan</button>
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

export function AddNewAddress(param: AddAddressParam) {
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
	const [modifyAddressWindowState, setAddOrModifyAddressWindowState] = useState<ModifyAddressWindowState | undefined>(undefined)
	const [onChainInformationVerifiedByUser, setOnChainInformationVerifiedByUser] = useState<boolean>(false)
	const [canFetchFromEtherScan, setCanFetchFromEtherScan] = useState<boolean>(false)
	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const parsed = ExternalPopupMessage.parse(msg)
			if (parsed.method === 'popup_fetchAbiAndNameFromEtherscanReply') {
				setCanFetchFromEtherScan(true)
				return setAddOrModifyAddressWindowState((previous) => {
					if (previous === undefined) return undefined
					if (parsed.data.windowStateId !== previous.windowStateId) return previous
					if (!parsed.data.success) {
						const newState = { ...previous, errorState: { blockEditing: false, message: parsed.data.error } }
						sendChangeRequest(newState)
						return newState
					}
					if (previous.errorState !== undefined) return previous
					const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, abi: parsed.data.abi, name: previous.incompleteAddressBookEntry.name === undefined ? parsed.data.contractName : previous.incompleteAddressBookEntry.name } }
					sendChangeRequest(newState)
					return newState
				})
			}
			if (parsed.method === 'popup_addOrModifyAddressWindowStateInformation') return setAddOrModifyAddressWindowState((previous) => {
				if (previous === undefined) return undefined
				if (parsed.data.windowStateId !== previous.windowStateId) return previous
				return { ...previous, errorState: parsed.data.errorState }
			})
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => { browser.runtime.onMessage.removeListener(popupMessageListener) }
	}, [])

	useEffect(() => {
		setActiveAddress(param.activeAddress)
		setAddOrModifyAddressWindowState(param.modifyAddressWindowState)
		setCanFetchFromEtherScan(stringToAddress(param.modifyAddressWindowState.incompleteAddressBookEntry.address) !== undefined)
	}, [param.modifyAddressWindowState.windowStateId, param.activeAddress])

	function getCompleteAddressBookEntry(): AddressBookEntry | undefined {
		if (modifyAddressWindowState === undefined) return undefined
		const incompleteAddressBookEntry = modifyAddressWindowState.incompleteAddressBookEntry
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
					entrySource: incompleteAddressBookEntry.entrySource,
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
					entrySource: incompleteAddressBookEntry.entrySource,
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
					entrySource: incompleteAddressBookEntry.entrySource,
					abi: incompleteAddressBookEntry.abi,
				}
			}
			case 'contact':
			case 'contract': return {
				type: incompleteAddressBookEntry.type,
				name,
				address: inputedAddressBigInt,
				logoUri: incompleteAddressBookEntry.logoUri,
				entrySource: incompleteAddressBookEntry.entrySource,
				abi: incompleteAddressBookEntry.abi,
			}
			case 'activeAddress': {
				return {
					type: 'activeAddress' as const,
					name,
					address: inputedAddressBigInt,
					askForAddressAccess: incompleteAddressBookEntry.askForAddressAccess,
					entrySource: incompleteAddressBookEntry.entrySource,
				}
			}
			default: assertUnreachable(incompleteAddressBookEntry.type)
		}
	}

	async function modifyOrAddEntry() {
		param.close()
		const entryToAdd = getCompleteAddressBookEntry()
		if (entryToAdd === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd } )
	}

	async function createAndSwitch() {
		if (modifyAddressWindowState === undefined) return
		const incompleteAddressBookEntry = modifyAddressWindowState.incompleteAddressBookEntry
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return
		await modifyOrAddEntry()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}

	const areInputsValid = () => getCompleteAddressBookEntry() !== undefined

	async function sendChangeRequest(newState: ModifyAddressWindowState) {
		if (modifyAddressWindowState === undefined) return
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_changeAddOrModifyAddressWindowState', data: {
				windowStateId: modifyAddressWindowState.windowStateId,
				newState,
			} })
		} catch(e) {
			console.error(e)
		}
	}

	const setAddress = async (address: string) => {
		setAddOrModifyAddressWindowState((previous) => {
			if (previous === undefined) return previous
			const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, address } }
			sendChangeRequest(newState)
			return newState
		})
		setCanFetchFromEtherScan(true)
	}
	const setName = async (name: string) => {
		setAddOrModifyAddressWindowState((previous) => {
			if (previous === undefined) return previous
			const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, name } }
			sendChangeRequest(newState)
			return newState
		})
	}
	const setAbi = async (abi: string | undefined) => {
		setAddOrModifyAddressWindowState((previous) => {
			if (previous === undefined) return previous
			const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, abi } }
			sendChangeRequest(newState)
			return newState
		})
		setCanFetchFromEtherScan(true)
	}
	const setSymbol = async (symbol: string) => {
		setAddOrModifyAddressWindowState((previous) => {
			if (previous === undefined) return previous
			const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, symbol } }
			sendChangeRequest(newState)
			return newState
		})
	}
	const setAskForAddressAccess = async (askForAddressAccess: boolean) => {
		setAddOrModifyAddressWindowState((previous) => {
			if (previous === undefined) return previous
			const newState = { ...previous, incompleteAddressBookEntry: { ... previous.incompleteAddressBookEntry, askForAddressAccess } }
			sendChangeRequest(newState)
			return newState
		})
	}
	async function fetchAbiAndNameFromEtherscan() {
		const address = stringToAddress(modifyAddressWindowState?.incompleteAddressBookEntry.address)
		if (address === undefined || modifyAddressWindowState === undefined) return
		setCanFetchFromEtherScan(false)
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchAbiAndNameFromEtherscan', data: {
			address,
			windowStateId: modifyAddressWindowState.windowStateId,
		} })
	}

	function showOnChainVerificationErrorBox() {
		if (modifyAddressWindowState === undefined) return false
		const incompleteAddressBookEntry = modifyAddressWindowState.incompleteAddressBookEntry
		return incompleteAddressBookEntry.entrySource === 'OnChain' && (incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC721')
	}

	function isSubmitButtonDisabled() {
		if (modifyAddressWindowState === undefined) return true
		return !areInputsValid()
			|| (modifyAddressWindowState.errorState !== undefined && modifyAddressWindowState.errorState.blockEditing)
			|| (showOnChainVerificationErrorBox() && !onChainInformationVerifiedByUser)
	}

	function getCardTitle() {
		if (modifyAddressWindowState === undefined) return '...'
		const incompleteAddressBookEntry = modifyAddressWindowState.incompleteAddressBookEntry
		if (incompleteAddressBookEntry.addingAddress) {
			return `Add New ${ readableAddressType[incompleteAddressBookEntry.type] }`
		}
		const alleged = showOnChainVerificationErrorBox() ? 'alleged ' : ''
		const name = incompleteAddressBookEntry.name !== undefined ? `${ alleged }${ incompleteAddressBookEntry.name }` : readableAddressType[incompleteAddressBookEntry.type]
		return `Modify ${ name }`
	}
	if (modifyAddressWindowState === undefined) return <></>
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
							incompleteAddressBookEntry = { modifyAddressWindowState.incompleteAddressBookEntry }
							setAddress = { setAddress }
							setName = { setName }
							setSymbol = { setSymbol }
							setAbi = { setAbi }
							setAskForAddressAccess = { setAskForAddressAccess }
							canFetchFromEtherScan = { canFetchFromEtherScan }
							fetchAbiAndNameFromEtherscan = { fetchAbiAndNameFromEtherscan }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; height: 80px'>
					{ modifyAddressWindowState?.errorState === undefined ? <></> : <Notice text = { modifyAddressWindowState.errorState.message } /> }
					{ !showOnChainVerificationErrorBox() ? <></> : 
						<ErrorCheckBox
							text = { `The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token's name, please verify elsewhere that this is the correct address for it.` }
							checked = { onChainInformationVerifiedByUser }
							onInput = { setOnChainInformationVerifiedByUser }
						/>
					}
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || modifyAddressWindowState?.incompleteAddressBookEntry === undefined || activeAddress === stringToAddress(modifyAddressWindowState.incompleteAddressBookEntry.address) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { ! (areInputsValid()) }> { modifyAddressWindowState.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled() }> { modifyAddressWindowState?.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
