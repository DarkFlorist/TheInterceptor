import { isAddress } from '../../utils/ethereumPrimitives.js'
import { useEffect } from 'preact/hooks'
import type { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, ErrorText } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { getMissingPopupReplyErrorMessage, requestPopupAbiAndNameFromBlockExplorer, requestPopupIdentifyAddress, sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { AddressIcon } from '../subcomponents/address.js'
import { assertUnreachable, modifyObject } from '../../utils/typescript.js'
import { type ComponentChildren, createRef } from 'preact'
import type { AddressBookEntry, AddressBookEntryType, DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import { isBlockExplorerAvailableForChain, isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import type { ChainEntry, RpcEntries } from '../../types/rpc.js'
import { type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { DropDownMenu } from '../subcomponents/DropDownMenu.js'
import { NonHexBigInt } from '../../types/wire-types.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { type AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { isValidAddressBookEntryName, MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH } from '../../utils/addressBookValidation.js'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSection, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'

export function mergeAddressWindowErrorState(
	currentErrorState: ModifyAddressWindowState['errorState'],
	validationErrorState: ModifyAddressWindowState['errorState'],
) {
	if (validationErrorState !== undefined) return validationErrorState
	if (currentErrorState?.blockEditing === false) return currentErrorState
	return undefined
}

export function getAddressWindowStateSyncErrorMessage(error: unknown) {
	if (error instanceof Error && error.message.length > 0) return `Failed to update address window state: ${ error.message }`
	return 'Failed to update address window state.'
}

export async function saveAddressBookEntry(entryToAdd: AddressBookEntry | { type: 'error', error: string }, close: () => void, sendMessage: (message: { method: 'popup_addOrModifyAddressBookEntry', data: AddressBookEntry }) => Promise<{ readonly ok: boolean, readonly message?: string } | undefined> = sendPopupMessageWithReply,
) {
	if (entryToAdd.type === 'error') return
	const reply = await sendMessage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd })
	if (reply === undefined) return 'Interceptor did not reply while validating the address-book entry.'
	if (reply.ok === false) return reply.message ?? 'Failed to save address-book entry.'
	close()
	return undefined
}

export async function saveAddressBookEntryAndSwitch(
	entryToAdd: AddressBookEntry | { type: 'error', error: string },
	close: () => void,
	setActiveAddressAndInformAboutIt: ((address: bigint) => Promise<void>) | undefined,
	sendMessage: (message: { method: 'popup_addOrModifyAddressBookEntry', data: AddressBookEntry }) => Promise<{ readonly ok: boolean, readonly message?: string } | undefined> = sendPopupMessageWithReply,
) {
	if (entryToAdd.type === 'error') return entryToAdd.error
	const saveError = await saveAddressBookEntry(entryToAdd, close, sendMessage)
	if (saveError !== undefined) return saveError
	await setActiveAddressAndInformAboutIt?.(entryToAdd.address)
	return undefined
}

const readableAddressType = {
	contact: 'Contact',
	activeAddress: 'Active Address',
	ERC20: 'ERC20',
	ERC721: 'ERC721',
	ERC1155: 'ERC1155',
	contract: 'contract',
	safe: 'Gnosis Safe Wallet',
}

export const BLOCK_EXPLORER_REPLY_MISSING_ERROR = getMissingPopupReplyErrorMessage('Fetching ABI from the block explorer')

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
		class = 'input title is-5 is-spaced'
		type = 'text'
		value = { nameInput }
		placeholder = { 'What should we call this address?' }
		onInput = { e => setNameInput((e.target as HTMLInputElement).value) }
		maxLength = { MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH }
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
		class = 'input subtitle is-7 is-spaced'
		type = 'text'
		value = { addressInput }
		placeholder = { '0x0...' }
		onInput = { e => setAddress((e.target as HTMLInputElement).value) }
		style = { `width: 100%;${ addressInput === undefined || isAddress(addressInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

type RenderinCompleteAddressBookParams = {
	modifyAddressWindowState: Signal<ModifyAddressWindowState>
	rpcEntries: Signal<RpcEntries>
	canFetchFromEtherScan: Signal<boolean>
	blockExplorerLookupState: AsyncStates
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
		class = 'input is-spaced'
		type = 'text'
		value = { abiInput }
		placeholder = { 'no abi' }
		onInput = { e => setAbiInput(e.currentTarget.value) }
		ref = { ref }
		disabled = { disabled }
		style = { `width: 100%;${ abiInput === undefined || isValidAbi(abiInput.trim()) ? '' : 'color: var(--negative-color);' }` }
	/>
}

export async function updateModifyAddressWindowState(
	modifyAddressWindowState: Signal<ModifyAddressWindowState>,
	updateState: (previousState: ModifyAddressWindowState) => ModifyAddressWindowState,
	sendMessage = sendPopupMessageToBackgroundPage,
) {
	const previousState = modifyAddressWindowState.peek()
	const updatedState = updateState(previousState)
	modifyAddressWindowState.value = updatedState
	try {
		await sendMessage({ method: 'popup_changeAddOrModifyAddressWindowState', data: { windowStateId: updatedState.windowStateId, newState: updatedState } })
	} catch(error) {
		modifyAddressWindowState.value = modifyObject(updatedState, {
			errorState: {
				blockEditing: false,
				message: getAddressWindowStateSyncErrorMessage(error),
			}
		})
	}
}

function RenderIncompleteAddressBookEntry({ modifyAddressWindowState, rpcEntries, canFetchFromEtherScan, blockExplorerLookupState, fetchAbiAndNameFromBlockExplorer }: RenderinCompleteAddressBookParams) {
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
	const addressBookEntryOptions = useSignal<readonly AddressBookEntryType[]>(['contact', 'contract', 'safe', 'ERC20', 'ERC1155', 'ERC721'])

	const onTypeChangedCallBack = (type: AddressBookEntryType) => {
		selectedAddresBookEntryType.value = type
		updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { type }))
	}

	const updateIncompleteAddressBookEntry = async (updateEntry: (previousEntry: ModifyAddressWindowState['incompleteAddressBookEntry']) => ModifyAddressWindowState['incompleteAddressBookEntry']) => updateModifyAddressWindowState(
		modifyAddressWindowState,
		previousState => modifyObject(previousState, {
			incompleteAddressBookEntry: updateEntry(previousState.incompleteAddressBookEntry),
			errorState: previousState.errorState?.blockEditing === false ? undefined : previousState.errorState
		})
	)

	const setAddress = async (address: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { address }))
	const setName = async (name: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { name }))
	const setChain = async (chainEntry: ChainEntry) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { chainId: chainEntry.chainId }))
	const setAbi = async (abi: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { abi: abi.trim().length === 0 ? undefined : abi }))
	const setSafeSignerAddress = async (safeSignerAddress: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { safeSignerAddress }))
	const setSafeSignerAddressAtIndex = async (index: number, safeSignerAddress: string) => updateIncompleteAddressBookEntry(previousEntry => {
		const safeSignerAddresses = [...(previousEntry.safeSignerAddresses ?? [])]
		const previousAddress = safeSignerAddresses[index]
		safeSignerAddresses[index] = safeSignerAddress
		return modifyObject(previousEntry, {
			safeSignerAddresses,
			safeSignerAddress: previousEntry.safeSignerAddress === previousAddress || previousEntry.safeSignerAddress === undefined
				? safeSignerAddress
				: previousEntry.safeSignerAddress,
		})
	})
	const addSafeSignerAddress = async () => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, {
		safeSignerAddresses: [...(previousEntry.safeSignerAddresses ?? []), ''],
	}))
	const removeSafeSignerAddress = async (index: number) => updateIncompleteAddressBookEntry(previousEntry => {
		const removedAddress = previousEntry.safeSignerAddresses?.[index]
		const safeSignerAddresses = (previousEntry.safeSignerAddresses ?? []).filter((_, signerIndex) => signerIndex !== index)
		return modifyObject(previousEntry, {
			safeSignerAddresses,
			safeSignerAddress: previousEntry.safeSignerAddress === removedAddress ? safeSignerAddresses[0] : previousEntry.safeSignerAddress,
		})
	})
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
					{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'safe' ? <>
						<div class = 'safe-signer-editor-title'><Text text = 'Gnosis Safe signers (optional)'/></div>
						{ (modifyAddressWindowState.value.incompleteAddressBookEntry.safeSignerAddresses ?? []).map((safeSignerAddress, index) =>
							<div class = 'safe-signer-editor-row' key = { index }>
								<input
									type = 'radio'
									name = 'active-safe-signer'
									aria-label = { `Use Gnosis Safe signer ${ index + 1 } as active signer` }
									checked = { modifyAddressWindowState.value.incompleteAddressBookEntry.safeSignerAddress === safeSignerAddress }
									disabled = { disableDueToSource || safeSignerAddress.trim().length === 0 }
									onInput = { () => { void setSafeSignerAddress(safeSignerAddress) } }
								/>
								<div>
									<AddressInput disabled = { disableDueToSource } addressInput = { safeSignerAddress } setAddress = { (address) => { void setSafeSignerAddressAtIndex(index, address) } } />
								</div>
								<button class = 'btn btn--outline is-small' type = 'button' disabled = { disableDueToSource } onClick = { () => { void removeSafeSignerAddress(index) } }>Remove</button>
							</div>
						) }
						<div class = 'safe-signer-editor-add'>
							<button class = 'btn btn--outline is-small' type = 'button' disabled = { disableDueToSource } onClick = { () => { void addSafeSignerAddress() } }>Add Gnosis Safe signer</button>
						</div>
					</> : <></> }
					{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' || modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC1155' ? <>
						<CellElement element = { <Text text = { 'Symbol: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } class = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' value = { modifyAddressWindowState.value.incompleteAddressBookEntry.symbol } placeholder = { '...' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setSymbol(e.target.value) } } } /> } />
					</> : <></> }
					{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' ? <>
						<CellElement element = { <Text text = { 'Decimals: ' }/> }/>
						<CellElement element = { <input disabled = { disableDueToSource } class = 'input subtitle is-7 is-spaced' style = 'width: 100%' type = 'text' inputMode = 'numeric' pattern = '[0-9]*' value = { decimals.value } placeholder = { '...' } onInput = { e => setDecimals(e) }/> } />
					</> : <></> }
					<CellElement element = { <Text text = { 'Abi: ' }/> }/>
					<CellElement element = { <>
						<AbiInput abiInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.abi } setAbiInput = { setAbi } disabled = { false }/>
						<div style = 'padding-left: 5px'/>
						<AsyncActionButton
							class = 'btn btn--outline is-small'
							state = { blockExplorerLookupState }
							text = 'Fetch from Block Explorer'
							pendingText = 'Fetching...'
							disabled = { stringToAddress(modifyAddressWindowState.value.incompleteAddressBookEntry.address) === undefined || !canFetchFromEtherScan.value || !blockExplorerAvailable.value }
							onClick = { fetchAbiAndNameFromBlockExplorer }
						/>
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
	const onChainInformationVerifiedByUser = useSignal<boolean>(false)
	const canFetchFromEtherScan = useSignal<boolean>(false)
	const lastCheckedAddress = useSignal<bigint>(0n)
	const { value: blockExplorerLookup, waitFor: waitForBlockExplorerLookup, reset: resetBlockExplorerLookup } = useAsyncState<void>()
	const isBlockExplorerLookupPending = useComputed(() => blockExplorerLookup.value.state === 'pending')

	useEffect(() => {
		const popupMessageListener = (msg: unknown): false => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method === 'popup_addOrModifyAddressWindowStateInformation') {
				if (parsed.data.windowStateId !== param.modifyAddressWindowState.value.windowStateId) return false
				param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, {
					errorState: mergeAddressWindowErrorState(param.modifyAddressWindowState.value.errorState, parsed.data.errorState)
				})
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
			const identifiedAddress = await requestPopupIdentifyAddress({ address })
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
		resetBlockExplorerLookup()
	}, [
		param.modifyAddressWindowState.value.windowStateId,
		param.modifyAddressWindowState.value.incompleteAddressBookEntry.address,
		param.modifyAddressWindowState.value.incompleteAddressBookEntry.chainId,
		param.activeAddress,
	])

	function getCompleteAddressBookEntry(): AddressBookEntry | { type: 'error', error: string } {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.peek().incompleteAddressBookEntry
		const inputedAddressBigInt = stringToAddress(incompleteAddressBookEntry.address)
		if (inputedAddressBigInt === undefined) return { type: 'error', error: 'Address is not valid' }
		const safeSignerAddressStrings = (incompleteAddressBookEntry.safeSignerAddresses ?? [])
			.map((address) => address.trim())
			.filter((address) => address.length > 0)
		const safeSignerAddresses = safeSignerAddressStrings.map(stringToAddress)
		if (incompleteAddressBookEntry.type === 'safe' && safeSignerAddresses.some((address) => address === undefined)) return { type: 'error', error: 'A Gnosis Safe signer address is not valid' }
		const parsedSafeSignerAddresses = safeSignerAddresses.filter((address): address is bigint => address !== undefined)
		const requestedSafeSignerAddress = stringToAddress(incompleteAddressBookEntry.safeSignerAddress)
		if (incompleteAddressBookEntry.type === 'safe' && incompleteAddressBookEntry.safeSignerAddress !== undefined && requestedSafeSignerAddress === undefined) return { type: 'error', error: 'Active Gnosis Safe signer address is not valid' }
		const safeSignerAddress = requestedSafeSignerAddress ?? parsedSafeSignerAddresses[0]
		if (incompleteAddressBookEntry.type === 'safe' && incompleteAddressBookEntry.chainId === 'AllChains') return { type: 'error', error: 'Gnosis Safe wallets must be assigned to a specific chain' }
		const name = incompleteAddressBookEntry.name ? incompleteAddressBookEntry.name : checksummedAddress(inputedAddressBigInt)
		if (!isValidAddressBookEntryName(name)) return { type: 'error', error: 'Name is not valid' }
		if (incompleteAddressBookEntry.abi !== undefined && !isValidAbi(incompleteAddressBookEntry.abi)) return { type: 'error', error: 'Abi is not valid' }
		const base = {
			name,
			address: inputedAddressBigInt,
			askForAddressAccess: incompleteAddressBookEntry.askForAddressAccess,
			chainId: incompleteAddressBookEntry.chainId,
			entrySource: 'User' as const,
			...(incompleteAddressBookEntry.declarativeNetRequestBlockMode !== undefined ? { declarativeNetRequestBlockMode: incompleteAddressBookEntry.declarativeNetRequestBlockMode } : {}),
			...(incompleteAddressBookEntry.useAsActiveAddress !== undefined ? { useAsActiveAddress: incompleteAddressBookEntry.useAsActiveAddress } : {}),
			...(incompleteAddressBookEntry.logoUri !== undefined ? { logoUri: incompleteAddressBookEntry.logoUri } : {}),
			...(incompleteAddressBookEntry.abi !== undefined ? { abi: incompleteAddressBookEntry.abi } : {}),
		}

		switch(incompleteAddressBookEntry.type) {
			case 'ERC721': {
				if (incompleteAddressBookEntry.symbol === undefined) return { type: 'error', error: 'Symbol is missing' }
				return {
					...base,
					type: 'ERC721' as const,
					symbol: incompleteAddressBookEntry.symbol,
				}
			}
			case 'ERC1155': {
				if (incompleteAddressBookEntry.symbol === undefined) return { type: 'error', error: 'Symbol is missing' }
				return {
					...base,
					type: 'ERC1155' as const,
					symbol: incompleteAddressBookEntry.symbol,
					decimals: undefined,
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
				}
			}
			case 'contact': return {
				...base,
				type: 'contact' as const,
			}
			case 'contract': return {
				...base,
				type: 'contract' as const,
			}
			case 'safe': {
				if (incompleteAddressBookEntry.chainId === 'AllChains') return { type: 'error', error: 'Gnosis Safe wallets must use a specific chain.' }
				return {
					...base,
					type: 'safe' as const,
					chainId: incompleteAddressBookEntry.chainId,
					useAsActiveAddress: true,
					...(safeSignerAddress === undefined ? {} : { safeSignerAddress }),
					...(parsedSafeSignerAddresses.length === 0 ? {} : { safeSignerAddresses: Array.from(new Set(parsedSafeSignerAddresses)) }),
					...(incompleteAddressBookEntry.safeVersion === undefined ? {} : { safeVersion: incompleteAddressBookEntry.safeVersion }),
				}
			}
			default: assertUnreachable(incompleteAddressBookEntry.type)
		}
	}

	async function modifyOrAddEntry() {
		const entryToAdd = getCompleteAddressBookEntry()
		const saveError = await saveAddressBookEntry(entryToAdd, param.close)
		if (saveError !== undefined) {
			param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, {
				errorState: { blockEditing: false, message: saveError }
			})
		}
	}

	async function createAndSwitch() {
		const entryToAdd = getCompleteAddressBookEntry()
		const saveError = await saveAddressBookEntryAndSwitch(entryToAdd, param.close, param.setActiveAddressAndInformAboutIt)
		if (saveError !== undefined) {
			param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, {
				errorState: { blockEditing: false, message: saveError }
			})
		}
	}

	const completeAddressBookEntryOrError = useComputed(() => {
		incompleteAddressBookEntry.value
		return getCompleteAddressBookEntry()
	})

	const areInputsValid = useComputed(() => completeAddressBookEntryOrError.value.type !== 'error')

	async function fetchAbiAndNameFromBlockExplorer() {
		const address = stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address)
		if (address === undefined) return
		const requestedChainId = param.modifyAddressWindowState.peek().incompleteAddressBookEntry.chainId
		const isCurrentLookup = () => {
			const currentEntry = param.modifyAddressWindowState.peek().incompleteAddressBookEntry
			return stringToAddress(currentEntry.address) === address && currentEntry.chainId === requestedChainId
		}
		waitForBlockExplorerLookup(async () => {
			const reply = await requestPopupAbiAndNameFromBlockExplorer({
				address,
				chainId: requestedChainId,
			})
			if (!isCurrentLookup()) return
			if (reply === undefined) {
				await updateModifyAddressWindowState(
					param.modifyAddressWindowState,
					previousState => modifyObject(previousState, { errorState: { blockEditing: false, message: BLOCK_EXPLORER_REPLY_MISSING_ERROR } })
				)
				return
			}
			if (!reply.data.success) {
				const error = reply.data.error
				await updateModifyAddressWindowState(
					param.modifyAddressWindowState,
					previousState => modifyObject(previousState, { errorState: { blockEditing: false, message: error } })
				)
				return
			}
			const { abi, contractName } = reply.data
			await updateModifyAddressWindowState(
				param.modifyAddressWindowState,
				previousState => modifyObject(previousState, {
					incompleteAddressBookEntry: modifyObject(previousState.incompleteAddressBookEntry, {
						abi,
						name: previousState.incompleteAddressBookEntry.name === undefined ? contractName : previousState.incompleteAddressBookEntry.name
					}),
					errorState: undefined
				})
			)
		})
	}

	const showOnChainVerificationErrorBox = useComputed(() => {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		return incompleteAddressBookEntry.entrySource === 'OnChain' && (incompleteAddressBookEntry.type === 'ERC20' || incompleteAddressBookEntry.type === 'ERC721')
	})

	const isSubmitButtonDisabled = useComputed(() => {
		return !areInputsValid.value
			|| (param.modifyAddressWindowState.value.errorState?.blockEditing)
			|| (showOnChainVerificationErrorBox.value && !onChainInformationVerifiedByUser.value)
			|| isBlockExplorerLookupPending.value
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
	const title = getCardTitle()
	const actionVerb = param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify'
	return <InterceptorDialogSurface ariaLabel = { title } closeDisabled = { isBlockExplorerLookupPending.value } onClose = { param.close } size = 'regular'>
		<InterceptorDialogHeader close = { param.close } closeDisabled = { isBlockExplorerLookupPending.value } closeLabel = 'Close address editor' icon = '../img/address-book.svg' title = { title } subtitle = 'Address book details and contract metadata'/>
		<InterceptorDialogBody>
			<InterceptorDialogSection>
				<RenderIncompleteAddressBookEntry
					modifyAddressWindowState = { param.modifyAddressWindowState }
					rpcEntries = { param.rpcEntries }
					canFetchFromEtherScan = { canFetchFromEtherScan }
					blockExplorerLookupState = { blockExplorerLookup.value.state }
					fetchAbiAndNameFromBlockExplorer = { fetchAbiAndNameFromBlockExplorer }
				/>
			</InterceptorDialogSection>
			<div class = 'interceptor-dialog-feedback'>
				{ completeAddressBookEntryOrError.value.type !== 'error' ? <></> : <ErrorText text = { completeAddressBookEntryOrError.value.error } /> }
				{ param.modifyAddressWindowState.value.errorState === undefined ? <></> : <ErrorText text = { param.modifyAddressWindowState.value.errorState.message } /> }
				{ !showOnChainVerificationErrorBox.value ? <></> : <ErrorCheckBox text = { `The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token's name, please verify elsewhere that this is the correct address for it.` } checked = { onChainInformationVerifiedByUser }/> }
			</div>
		</InterceptorDialogBody>
		<InterceptorDialogFooter>
			<button type = 'button' class = 'btn btn--ghost' onClick = { param.close } disabled = { isBlockExplorerLookupPending.value }>Cancel</button>
			{ param.setActiveAddressAndInformAboutIt === undefined || param.modifyAddressWindowState.value.incompleteAddressBookEntry === undefined || activeAddress.value === stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) ? <></> : <button type = 'button' class = 'btn btn--outline' onClick = { createAndSwitch } disabled = { !areInputsValid.value || isBlockExplorerLookupPending.value }>{ actionVerb } and switch</button> }
			<button type = 'button' class = 'btn btn--primary' onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled.value }>{ actionVerb }</button>
		</InterceptorDialogFooter>
	</InterceptorDialogSurface>
}
