import { ethers } from 'ethers'
import { useEffect, useState } from 'preact/hooks'
import { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, Notice } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable, modifyObject } from '../../utils/typescript.js'
import { ComponentChildren, createRef } from 'preact'
import { AddressBookEntry, DeclarativeNetRequestBlockMode, IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import { isBlockExplorerAvailableForChain, isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import { ChainEntry, RpcEntries } from '../../types/rpc.js'
import { ReadonlySignal, Signal, useComputed } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

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
	incompleteAddressBookEntry: ReadonlySignal<IncompleteAddressBookEntry | undefined>
	rpcEntries: Signal<RpcEntries>
	canFetchFromEtherScan: boolean
	setName: (name: string) => void
	setAddress: (address: string) => void
	setSymbol: (symbol: string) => void
	setAskForAddressAccess: (name: boolean) => void
	setUseAsActiveAddress: (useAsActiveAddress: boolean) => void
	setDeclarativeNetRequestBlockMode: (declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode) => void
	setAbi: (abi: string) => void
	fetchAbiAndNameFromBlockExplorer: () => Promise<void>
	setChain: (chainEntry: ChainEntry) => void
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
		placeholder = { 'not available / not retrieved' }
		onInput = { e => setAbiInput(e.currentTarget.value) }
		ref = { ref }
		disabled = { disabled }
		style = { `width: 100%;${ abiInput === undefined || isValidAbi(abiInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

function RenderIncompleteAddressBookEntry({ rpcEntries, incompleteAddressBookEntry, setName, setAddress, setSymbol, setAskForAddressAccess, setAbi, canFetchFromEtherScan, fetchAbiAndNameFromBlockExplorer, setUseAsActiveAddress, setDeclarativeNetRequestBlockMode, setChain }: RenderinCompleteAddressBookParams) {
	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width: 100%'>
			{ param.text }
		</p>
	}
	if (incompleteAddressBookEntry.value === undefined) return <></>
	const disableDueToSource = incompleteAddressBookEntry.value.entrySource === 'DarkFloristMetadata' || incompleteAddressBookEntry.value.entrySource === 'Interceptor'
	const logoUri = incompleteAddressBookEntry.value.addingAddress === false && 'logoUri' in incompleteAddressBookEntry ? incompleteAddressBookEntry.value.logoUri : undefined
	const selectedChainId = useComputed(() => incompleteAddressBookEntry.value?.chainId || 1n)
	const blockExplorerAvailable = useComputed(() => isBlockExplorerAvailableForChain(selectedChainId.value, rpcEntries.value))
	return <div class = 'media'>
		<div class = 'media-left'>
			<figure class = 'image'>
				<IncompleteAddressIcon addressInput = { incompleteAddressBookEntry.value.address } logoUri = { logoUri }/>
			</figure>
		</div>
		<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
			<div class = 'container' style = 'margin-bottom: 10px;'>
				<span class = 'log-table' style = 'column-gap: 5px; row-gap: 5px; grid-template-columns: max-content auto;'>
					<CellElement element = { <Text text = { 'Chain: ' }/> }/>
					<CellElement element = { <ChainSelector rpcEntries = { rpcEntries } chainId = { selectedChainId } changeChain = { setChain }/> } />
					<CellElement element = { <Text text = { 'Name: ' }/> }/>
					<CellElement element = { <NameInput nameInput = { incompleteAddressBookEntry.value.name } setNameInput = { setName } disabled = { disableDueToSource }/> } />
					<CellElement element = { <Text text = { 'Address: ' }/> }/>
					<CellElement element = { <AddressInput disabled = { incompleteAddressBookEntry.value.addingAddress === false || disableDueToSource } addressInput = { incompleteAddressBookEntry.value.address } setAddress = { setAddress } /> } />
					{ incompleteAddressBookEntry.value.type === 'ERC20' || incompleteAddressBookEntry.value.type === 'ERC1155' ? <>
						<CellElement element = { <Text text = { 'Symbol: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { incompleteAddressBookEntry.value.symbol } placeholder = { '...' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setSymbol(e.target.value) } } } /> } />
					</> : <></> }
					{ incompleteAddressBookEntry.value.type === 'ERC20' ? <>
						<CellElement element = { <Text text = { 'Decimals: ' }/> }/>
						<CellElement element = { <input disabled = { true } className = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { incompleteAddressBookEntry.value.decimals !== undefined ? incompleteAddressBookEntry.value.decimals.toString() : incompleteAddressBookEntry.value.decimals } placeholder = { '...' } /> } />
					</> : <></> }
					<CellElement element = { <Text text = { 'Abi: ' }/> }/>
					<CellElement element = { <>
						<AbiInput abiInput = { incompleteAddressBookEntry.value.abi } setAbiInput = { setAbi } disabled = { false }/>
						<div style = 'padding-left: 5px'/>
						<button class = 'button is-primary is-small' disabled = { stringToAddress(incompleteAddressBookEntry.value.address) === undefined || !canFetchFromEtherScan || !blockExplorerAvailable.value } onClick = { async  () => { fetchAbiAndNameFromBlockExplorer() } }> Fetch from Block Explorer</button>
					</> }/>
				</span>
			</div>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { incompleteAddressBookEntry.value.useAsActiveAddress } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setUseAsActiveAddress(e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Use as active address</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { !incompleteAddressBookEntry.value.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Don't request for an access when used as active address(insecure)</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { 'declarativeNetRequestBlockMode' in incompleteAddressBookEntry && incompleteAddressBookEntry.value.declarativeNetRequestBlockMode === 'block-all' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setDeclarativeNetRequestBlockMode(e.target.checked ? 'block-all' : 'disabled') } } } />
				<p class = 'paragraph checkbox-text'>Block all external requests on site when this address is active (not recommended).</p>
			</label>
		</div>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const [activeAddress, setActiveAddress] = useState<bigint | undefined>(undefined)
	const [onChainInformationVerifiedByUser, setOnChainInformationVerifiedByUser] = useState<boolean>(false)
	const [canFetchFromEtherScan, setCanFetchFromEtherScan] = useState<boolean>(false)

	useEffect(() => {
		const popupMessageListener = (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_fetchAbiAndNameFromBlockExplorerReply') {
				if (param.modifyAddressWindowState.value === undefined || parsed.data.windowStateId !== param.modifyAddressWindowState.value.windowStateId) return
				setCanFetchFromEtherScan(true)
				if (!parsed.data.success) {
					param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { errorState: { blockEditing: false, message: parsed.data.error } })
					return
				}
				if (param.modifyAddressWindowState.value.errorState !== undefined) return
				param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { incompleteAddressBookEntry: modifyObject(param.modifyAddressWindowState.value.incompleteAddressBookEntry, { abi: parsed.data.abi, name: param.modifyAddressWindowState.value.incompleteAddressBookEntry.name === undefined ? parsed.data.contractName : param.modifyAddressWindowState.value.incompleteAddressBookEntry.name }) } )
				return
			}
			if (parsed.method === 'popup_addOrModifyAddressWindowStateInformation') {
				if (param.modifyAddressWindowState.value === undefined) return
				if (parsed.data.windowStateId !== param.modifyAddressWindowState.value.windowStateId) return
				if (parsed.data.identifiedAddress !== undefined && parsed.data.identifiedAddress.type === 'ERC20' && param.modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20') {
					param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { incompleteAddressBookEntry: { ...param.modifyAddressWindowState.value.incompleteAddressBookEntry, decimals: parsed.data.identifiedAddress.decimals }, errorState: parsed.data.errorState })
				} else {
					param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { errorState: parsed.data.errorState })
				}
			}
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => {
		setActiveAddress(param.activeAddress)
		if (param.modifyAddressWindowState.value !== undefined) setCanFetchFromEtherScan(stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) !== undefined)
	}, [param.modifyAddressWindowState.value?.windowStateId, param.activeAddress])

	function getCompleteAddressBookEntry(): AddressBookEntry | undefined {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.peek()?.incompleteAddressBookEntry
		if (incompleteAddressBookEntry === undefined) return undefined
		if (incompleteAddressBookEntry.name !== undefined && incompleteAddressBookEntry.name.length > 42) return undefined
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return undefined
		const name = incompleteAddressBookEntry.name ? incompleteAddressBookEntry.name : checksummedAddress(inputedAddressBigInt)
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
				if (incompleteAddressBookEntry.symbol === undefined) return undefined
				return {
					...base,
					type: 'ERC721' as const,
					symbol: incompleteAddressBookEntry.symbol,
					logoUri: incompleteAddressBookEntry.logoUri,
					abi,
				}
			}
			case 'ERC1155': {
				if (incompleteAddressBookEntry.symbol === undefined) return undefined
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
				if (incompleteAddressBookEntry.symbol === undefined || incompleteAddressBookEntry.decimals === undefined) return undefined
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
		param.close()
		if (entryToAdd === undefined) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd } )
	}

	async function createAndSwitch() {
		if (param.modifyAddressWindowState.value === undefined) return
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return
		await modifyOrAddEntry()
		if (param.setActiveAddressAndInformAboutIt !== undefined) await param.setActiveAddressAndInformAboutIt(inputedAddressBigInt)
	}

	const areInputsValid = () => getCompleteAddressBookEntry() !== undefined

	async function modifyState(newState: ModifyAddressWindowState) {
		if (newState === undefined) return
		param.modifyAddressWindowState.value = newState
		try {
			await sendPopupMessageToBackgroundPage({ method: 'popup_changeAddOrModifyAddressWindowState', data: { windowStateId: newState.windowStateId, newState } })
		} catch(e) {
			console.error(e)
		}
	}

	const setAddress = async (address: string) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { address }) }))
		setCanFetchFromEtherScan(true)
	}
	const setName = async (name: string) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { name }) }))
	}
	const setChain = async (chainEntry: ChainEntry) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { chainId: chainEntry.chainId }) }))
	}
	const setAbi = async (abi: string | undefined) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { abi }) }))
		setCanFetchFromEtherScan(true)
	}
	const setSymbol = async (symbol: string) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { symbol }) }))
	}
	const setUseAsActiveAddress = async (useAsActiveAddress: boolean) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { useAsActiveAddress }) }))
	}
	const setDeclarativeNetRequestBlockMode = async (declarativeNetRequestBlockMode: DeclarativeNetRequestBlockMode) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { declarativeNetRequestBlockMode }) }))
	}
	const setAskForAddressAccess = async (askForAddressAccess: boolean) => {
		const previous = param.modifyAddressWindowState.peek()
		if (previous === undefined) return
		modifyState(modifyObject(previous, { incompleteAddressBookEntry: modifyObject(previous.incompleteAddressBookEntry, { askForAddressAccess }) }))
	}
	async function fetchAbiAndNameFromBlockExplorer() {
		const address = stringToAddress(param.modifyAddressWindowState.value?.incompleteAddressBookEntry.address)
		if (address === undefined || param.modifyAddressWindowState.value === undefined) return
		setCanFetchFromEtherScan(false)
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchAbiAndNameFromBlockExplorer', data: {
			address,
			windowStateId: param.modifyAddressWindowState.value.windowStateId,
			chainId: param.modifyAddressWindowState.value.incompleteAddressBookEntry.chainId
		} })
	}

	const showOnChainVerificationErrorBox = useComputed(() => {
		if (param.modifyAddressWindowState.value === undefined) return false
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		return incompleteAddressBookEntry.entrySource === 'OnChain' && (incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC721')
	})


	const isSubmitButtonDisabled = useComputed(() => {
		if (param.modifyAddressWindowState.value === undefined) return true
		return !areInputsValid()
			|| (param.modifyAddressWindowState.value.errorState?.blockEditing)
			|| (showOnChainVerificationErrorBox.value && !onChainInformationVerifiedByUser)
	})

	function getCardTitle() {
		if (param.modifyAddressWindowState.value === undefined) return '...'
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		if (incompleteAddressBookEntry.addingAddress) {
			return `Add New ${ readableAddressType[incompleteAddressBookEntry.type] }`
		}
		const alleged = showOnChainVerificationErrorBox.value ? 'alleged ' : ''
		const name = incompleteAddressBookEntry.name !== undefined ? `${ alleged }${ incompleteAddressBookEntry.name }` : readableAddressType[incompleteAddressBookEntry.type]
		return `Modify ${ name }`
	}
	const incompleteAddressBookEntry = useComputed(() => param.modifyAddressWindowState.value?.incompleteAddressBookEntry )
	if (incompleteAddressBookEntry.value === undefined) return <></>
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
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<RenderIncompleteAddressBookEntry
							incompleteAddressBookEntry = { incompleteAddressBookEntry }
							setAddress = { setAddress }
							setName = { setName }
							setSymbol = { setSymbol }
							setAbi = { setAbi }
							setChain = { setChain }
							rpcEntries = { param.rpcEntries }
							setUseAsActiveAddress = { setUseAsActiveAddress }
							setDeclarativeNetRequestBlockMode = { setDeclarativeNetRequestBlockMode }
							setAskForAddressAccess = { setAskForAddressAccess }
							canFetchFromEtherScan = { canFetchFromEtherScan }
							fetchAbiAndNameFromBlockExplorer = { fetchAbiAndNameFromBlockExplorer }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ param.modifyAddressWindowState.value?.errorState === undefined ? <></> : <Notice text = { param.modifyAddressWindowState.value.errorState.message } /> }
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
				{ param.setActiveAddressAndInformAboutIt === undefined || param.modifyAddressWindowState.value?.incompleteAddressBookEntry === undefined || activeAddress === stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) ? <></> : <button class = 'button is-success is-primary' onClick = { createAndSwitch } disabled = { !areInputsValid() }> { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } </button> }
				<button class = 'button is-success is-primary' onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled.value }> { param.modifyAddressWindowState.value?.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } </button>
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close }>Cancel</button>
			</footer>
		</div>
	</> )
}
