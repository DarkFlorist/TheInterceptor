import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, ErrorText } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable, modifyObject } from '../../utils/typescript.js'
import { ComponentChildren, createRef } from 'preact'
import { AddressBookEntry, AddressBookEntryType, DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import { isBlockExplorerAvailableForChain, isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import { ChainEntry, RpcEntries } from '../../types/rpc.js'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { DropDownMenu } from '../subcomponents/DropDownMenu.js'
import { NonHexBigInt } from '../../types/wire-types.js'

const readableAddressType = {
	contact: 'Contact',
	activeAddress: 'Active Address',
	ERC20: 'ERC20',
	ERC721: 'ERC721',
	ERC1155: 'ERC1155',
	contract: 'contract',
}

type IncompleteAddressIconParams = {
	addressInput: string | undefined,
	logoUri: string | undefined,
}

function IncompleteAddressIcon({ addressInput, logoUri }: IncompleteAddressIconParams) {
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

function NameInput({ nameInput, setNameInput, disabled }: NameInputParams) {
	const ref = createRef<HTMLInputElement>()
    useEffect(() => { ref.current?.focus() }, [])
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

function AddressInput({ disabled, addressInput, setAddress }: AddressInputParams) {
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
	modifyAddressWindowState: Signal<ModifyAddressWindowState>
	rpcEntries: Signal<RpcEntries>
	canFetchFromEtherScan: Signal<boolean>
	fetchAbiAndNameFromBlockExplorer: () => Promise<void>
}

const CellElement = (param: { element: ComponentChildren }) => {
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
    useEffect(() => { ref.current?.focus() }, [])
	return <input
		className = 'input is-spaced'
		type = 'text'
		value = { abiInput }
		placeholder = { 'no abi' }
		onInput = { e => setAbiInput(e.currentTarget.value) }
		ref = { ref }
		disabled = { disabled }
		style = { `width: 100%;${ abiInput === undefined || isValidAbi(abiInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

function RenderIncompleteAddressBookEntry({ modifyAddressWindowState, rpcEntries, canFetchFromEtherScan, fetchAbiAndNameFromBlockExplorer }: RenderinCompleteAddressBookParams) {
	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width: 100%'>
			{ param.text }
		</p>
	}
	const disableDueToSource = modifyAddressWindowState.value.incompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || modifyAddressWindowState.value.incompleteAddressBookEntry.entrySource === 'Interceptor'
	const logoUri = modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress === false && 'logoUri' in modifyAddressWindowState.value.incompleteAddressBookEntry ? modifyAddressWindowState.value.incompleteAddressBookEntry.logoUri : undefined
	const selectedChainId = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.chainId || 1n)
	const blockExplorerAvailable = useComputed(() => isBlockExplorerAvailableForChain(selectedChainId.value, rpcEntries.value))

	const selectedAddresBookEntryType = useSignal<AddressBookEntryType>(modifyAddressWindowState.value.incompleteAddressBookEntry.type)
	const addressBookEntryOptions = useSignal<readonly AddressBookEntryType[]>(['contact', 'contract', 'ERC20', 'ERC1155', 'ERC721'])

	const onTypeChangedCallBack = (type: AddressBookEntryType) => {
		selectedAddresBookEntryType.value = type
		updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { type }))
	}

	type ModifyEntry = typeof modifyAddressWindowState.peek extends () => infer State ? (State extends { incompleteAddressBookEntry: infer Entry } ? Entry : never) : never
	const updateIncompleteAddressBookEntry = async (updateEntry: (previousEntry: ModifyEntry) => ModifyEntry) => {
		const previousState = modifyAddressWindowState.peek()
		modifyAddressWindowState.value = modifyObject(previousState, { incompleteAddressBookEntry: updateEntry(previousState.incompleteAddressBookEntry) })
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_changeAddOrModifyAddressWindowState', data: { windowStateId: modifyAddressWindowState.value.windowStateId, newState: modifyAddressWindowState.value } })
		} catch(e) {
			console.error(e)
		}
	}

	const setAddress = async (address: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { address }))
	const setName = async (name: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { name }))
	const setChain = async (chainEntry: ChainEntry) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { chainId: chainEntry.chainId }))
	const setAbi = async (abi: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { abi: abi.trim().length === 0 ? undefined : abi }))
	const setSymbol = async (symbol: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { symbol }))
	const setDecimals = async (inputEvent: Event) => updateIncompleteAddressBookEntry(previousEntry => {
		if (!(inputEvent.target instanceof HTMLInputElement) || inputEvent.target === null) return previousEntry
		const inputElement = inputEvent.target
		const decimals = inputElement.value
		const parseDecimalsString = () => {
			if (decimals.length === 0) return undefined
			const parsed = NonHexBigInt.safeParse(decimals)
			if (parsed.success) return parsed.value
			return previousEntry.decimals
		}
		const parsed = parseDecimalsString()
		inputElement.value = parsed === undefined ? '' : parsed.toString()
		return modifyObject(previousEntry, { decimals: parsed })
	})
	const setUseAsActiveAddress = async (useAsActiveAddress: boolean) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { useAsActiveAddress }))
	const setDeclarativeNetRequestBlockMode = async (declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { declarativeNetRequestBlockMode }))
	const setAskForAddressAccess = async (askForAddressAccess: boolean) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { askForAddressAccess }))

	const decimals = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.decimals !== undefined ? modifyAddressWindowState.value.incompleteAddressBookEntry.decimals.toString() : undefined)
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.address } logoUri = { logoUri }/>
			</figure>
		</div>
		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<div class = 'container' style = 'margin-bottom: 10px;'>
				<span class = 'log-table' style = 'column-gap: 5px; row-gap: 5px; grid-template-columns: max-content auto;'>
					<CellElement element = { <Text text = { 'Address type: ' }/> }/>
					<div style = { { justifyContent: 'right', display: 'flex' } }> <DropDownMenu selected = { selectedAddresBookEntryType } dropDownOptions = { addressBookEntryOptions } onChangedCallBack = { onTypeChangedCallBack } buttonClassses = { 'btn btn--outline is-small' }/> </div>
					<CellElement element = { <Text text = { 'Chain: ' }/> }/>
					<div style = { { justifyContent: 'right', display: 'flex' } }> <ChainSelector rpcEntries = { rpcEntries } chainId = { selectedChainId } changeChain = { setChain } buttonClassses = { 'btn btn--outline is-small' }/> </div>
					<CellElement element = { <Text text = { 'Name: ' }/> }/>
					<CellElement element = { <NameInput nameInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.name } setNameInput = { setName } disabled = { disableDueToSource }/> } />
					<CellElement element = { <Text text = { 'Address: ' }/> }/>
					<CellElement element = { <AddressInput disabled = { modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress === false || disableDueToSource } addressInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.address } setAddress = { setAddress } /> } />
					{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' || modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC1155' ? <>
						<CellElement element = { <Text text = { 'Symbol: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { modifyAddressWindowState.value.incompleteAddressBookEntry.symbol } placeholder = { '...' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setSymbol(e.target.value) } } } /> } />
					</> : <></> }
					{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' ? <>
						<CellElement element = { <Text text = { 'Decimals: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' inputMode = 'numeric' pattern = '[0-9]*' value = { decimals.value } placeholder = { '...' } onInput = { e => setDecimals(e) }/> } />
					</> : <></> }
					<CellElement element = { <Text text = { 'Abi: ' }/> }/>
					<CellElement element = { <>
						<AbiInput abiInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.abi } setAbiInput = { setAbi } disabled = { false }/>
						<div style = 'padding-left: 5px'/>
						<button class = 'btn btn--outline is-small' disabled = { stringToAddress(modifyAddressWindowState.value.incompleteAddressBookEntry.address) === undefined || !canFetchFromEtherScan.value || !blockExplorerAvailable.value } onClick = { async  () => { fetchAbiAndNameFromBlockExplorer() } }> Fetch from Block Explorer</button>
					</> }/>
				</span>
			</div>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { modifyAddressWindowState.value.incompleteAddressBookEntry.useAsActiveAddress } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setUseAsActiveAddress(e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Use as active address</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { !modifyAddressWindowState.value.incompleteAddressBookEntry.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Don't request for an access when used as active address(insecure)</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { 'declarativeNetRequestBlockMode' in modifyAddressWindowState.value.incompleteAddressBookEntry && modifyAddressWindowState.value.incompleteAddressBookEntry.declarativeNetRequestBlockMode === 'block-all' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setDeclarativeNetRequestBlockMode(e.target.checked ? 'block-all' : 'disabled') } } } />
				<p class = 'paragraph checkbox-text'>Block all external requests on site when this address is active (not recommended).</p>
			</label>
		</div>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const [onChainInformationVerifiedByUser, setOnChainInformationVerifiedByUser] = useState<boolean>(false)
	const canFetchFromEtherScan = useSignal<boolean>(false)
	const lastCheckedAddress = useSignal<bigint>(0n)

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_addOrModifyAddressWindowStateInformation') {
				if (parsed.data.windowStateId !== param.modifyAddressWindowState.value.windowStateId) return false
				param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { errorState: parsed.data.errorState })
			}
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useSignalEffect(() => {
		// if user is adding a new address, fetch decimals and name from contract everytime that address changes
		// we do not need to do that in case user is editing an address, as this data should have been fetched already
		const identifyAddress = async () => {
			if (!param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress) return
			const address = stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address)
			if (address === undefined) return
			if (lastCheckedAddress.value === address) return
			lastCheckedAddress.value = address
			const identifiedAddress = await sendPopupMessageWithReply({ method: 'popup_requestIdentifyAddress', data: { address } })
			if (identifiedAddress === undefined) return
			if (identifiedAddress.data.addressBookEntry.type === 'ERC20') {
				param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { incompleteAddressBookEntry: {
					...param.modifyAddressWindowState.value.incompleteAddressBookEntry,
					name: identifiedAddress.data.addressBookEntry.name,
					decimals: identifiedAddress.data.addressBookEntry.decimals,
				} })
			}
		}
		if (param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress !== true) return
		if (stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) === lastCheckedAddress.value) return
		identifyAddress()
	})

	useEffect(() => {
		activeAddress.value = param.activeAddress
		if (param.modifyAddressWindowState.value !== undefined) {
			canFetchFromEtherScan.value = stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) !== undefined
		}
	}, [param.modifyAddressWindowState.value.windowStateId, param.activeAddress])

	function getCompleteAddressBookEntry(): AddressBookEntry | { type: 'error', error: string } {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.peek().incompleteAddressBookEntry
		if (incompleteAddressBookEntry.name !== undefined && incompleteAddressBookEntry.name.length > 42) return { type: 'error', error: 'Name is not valid' }
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return { type: 'error', error: 'Address is not valid' }
		const name = incompleteAddressBookEntry.name ? incompleteAddressBookEntry.name : checksummedAddress(inputedAddressBigInt)
		if (incompleteAddressBookEntry.abi !== undefined && !isValidAbi(incompleteAddressBookEntry.abi)) return { type: 'error', error: 'Abi is not valid' }
		const abi = incompleteAddressBookEntry.abi || undefined
		const base = {
			name,
			address: inputedAddressBigInt,
			declarativeNetRequestBlockMode: incompleteAddressBookEntry.declarativeNetRequestBlockMode,
			useAsActiveAddress: incompleteAddressBookEntry.useAsActiveAddress,
			askForAddressAccess: incompleteAddressBookEntry.askForAddressAccess,
			chainId: incompleteAddressBookEntry.chainId,
			entrySource: 'User' as const,
		}

		switch(incompleteAddressBookEntry.type) {
			case 'ERC721': {
				if (incompleteAddressBookEntry.symbol === undefined) return { type: 'error', error: 'Symbol is missing' }
				return {
					...base,
					type: 'ERC721' as const,
					symbol: incompleteAddressBookEntry.symbol,
					logoUri: incompleteAddressBookEntry.logoUri,
					abi,
				}
			}
			case 'ERC1155': {
				if (incompleteAddressBookEntry.symbol === undefined) return { type: 'error', error: 'Symbol is missing' }
				return {
					...base,
					type: 'ERC1155' as const,
					symbol: incompleteAddressBookEntry.symbol,
					logoUri: incompleteAddressBookEntry.logoUri,
					decimals: undefined,
					abi,
				}
			}
			case 'ERC20': {
				if (incompleteAddressBookEntry.symbol === undefined) return { type: 'error', error: 'Symbol is missing' }
				if (incompleteAddressBookEntry.decimals === undefined) return { type: 'error', error: 'Decimals are missing' }
				return {
					...base,
					type: 'ERC20' as const,
					symbol: incompleteAddressBookEntry.symbol,
					decimals: incompleteAddressBookEntry.decimals,
					logoUri: incompleteAddressBookEntry.logoUri,
					abi,
				}
			}
			case 'contact':
			case 'contract': return {
				...base,
				type: incompleteAddressBookEntry.type,
				logoUri: incompleteAddressBookEntry.logoUri,
				abi,
			}
			default: assertUnreachable(incompleteAddressBookEntry.type)
		}
	}

	async function modifyOrAddEntry() {
		const entryToAdd = getCompleteAddressBookEntry()
		if (entryToAdd.type === 'error') return
		param.close()
		await sendPopupMessageToBackgroundPage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd } )
	}

	async function createAndSwitch() {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return
		await modifyOrAddEntry()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}

	const completeAddressBookEntryOrError = useComputed(() => {
		incompleteAddressBookEntry.value
		return getCompleteAddressBookEntry()
	})

	const areInputsValid = useComputed(() => completeAddressBookEntryOrError.value.type !== 'error')

	async function fetchAbiAndNameFromBlockExplorer() {
		const address = stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address)
		if (address === undefined) return
		canFetchFromEtherScan.value = false
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestAbiAndNameFromBlockExplorer', data: {
			address,
			chainId: param.modifyAddressWindowState.value.incompleteAddressBookEntry.chainId
		} })
		if (reply === undefined) return
		canFetchFromEtherScan.value = true
		if (!reply.data.success) {
			param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, {
				errorState: { blockEditing: false, message: reply.data.error }
			})
			return
		}
		param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, {
			incompleteAddressBookEntry: modifyObject(param.modifyAddressWindowState.value.incompleteAddressBookEntry, {
				abi: reply.data.abi,
				name: param.modifyAddressWindowState.value.incompleteAddressBookEntry.name === undefined ? reply.data.contractName : param.modifyAddressWindowState.value.incompleteAddressBookEntry.name
			}),
			errorState: undefined
		} )
	}

	const showOnChainVerificationErrorBox = useComputed(() => {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		return incompleteAddressBookEntry.entrySource === 'OnChain' && (incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC721')
	})

	const isSubmitButtonDisabled = useComputed(() => {
		return !areInputsValid.value
			|| (param.modifyAddressWindowState.value.errorState?.blockEditing)
			|| (showOnChainVerificationErrorBox.value && !onChainInformationVerifiedByUser)
	})

	function getCardTitle() {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		if (incompleteAddressBookEntry.addingAddress) {
			return `Add New ${ readableAddressType[incompleteAddressBookEntry.type] }`
		}
		const alleged = showOnChainVerificationErrorBox.value ? 'alleged ' : ''
		const name = incompleteAddressBookEntry.name !== undefined ? `${ alleged }${ incompleteAddressBookEntry.name }` : readableAddressType[incompleteAddressBookEntry.type]
		return `Modify ${ name }`
	}
	const incompleteAddressBookEntry = useComputed(() => param.modifyAddressWindowState.value.incompleteAddressBookEntry )
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
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<RenderIncompleteAddressBookEntry
							modifyAddressWindowState = { param.modifyAddressWindowState }
							rpcEntries = { param.rpcEntries }
							canFetchFromEtherScan = { canFetchFromEtherScan }
							fetchAbiAndNameFromBlockExplorer = { fetchAbiAndNameFromBlockExplorer }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ completeAddressBookEntryOrError.value.type !== 'error' ? <></> : <ErrorText text = { completeAddressBookEntryOrError.value.error } /> }

					{ param.modifyAddressWindowState.value.errorState === undefined ? <></> : <ErrorText text = { param.modifyAddressWindowState.value.errorState.message } /> }
					{ !showOnChainVerificationErrorBox.value ? <></> :
						<ErrorCheckBox
							text = { `The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token's name, please verify elsewhere that this is the correct address for it.` }
							checked = { onChainInformationVerifiedByUser }
							onInput = { setOnChainInformationVerifiedByUser }
						/>
					}
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || param.modifyAddressWindowState.value.incompleteAddressBookEntry === undefined || activeAddress.value === stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { !areInputsValid.value }>
					{ param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' }
				</button> }
				<button class = 'button is-success is-primary' onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled.value }> { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
