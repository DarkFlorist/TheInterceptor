import { isAddress } from '../../utils/ethereumPrimitives.js'
import { useEffect } from 'preact/hooks'
import type { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, ErrorText } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { getMissingPopupReplyErrorMessage, requestPopupAbiAndNameFromBlockExplorer, requestPopupIdentifyAddress, sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { AddressIcon, getActiveAddressEntry, SmallAddress } from '../subcomponents/address.js'
import { assertUnreachable, modifyObject } from '../../utils/typescript.js'
import { createRef } from 'preact'
import type { AddressBookEntries, AddressBookEntry, AddressBookEntryType, ChainIdWithUniversal, DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import { isBlockExplorerAvailableForChain, isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { XMarkIcon } from '../subcomponents/icons.js'
import { ChainSelector } from '../subcomponents/ChainSelector.js'
import type { ChainEntry, RpcEntries } from '../../types/rpc.js'
import { type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { DropDownMenu } from '../subcomponents/DropDownMenu.js'
import { NonHexBigInt } from '../../types/wire-types.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { type AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { isValidAddressBookEntryName, MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH } from '../../utils/addressBookValidation.js'
import { isValidErc20Decimals } from '../../utils/erc20.js'

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

export function isAddressBookSubmissionDisabled({
	areInputsValid,
	blockEditing,
	requiresOnChainVerification,
	isOnChainInformationVerified,
	isBlockExplorerLookupPending,
}: {
	areInputsValid: boolean
	blockEditing: boolean
	requiresOnChainVerification: boolean
	isOnChainInformationVerified: boolean
	isBlockExplorerLookupPending: boolean
}) {
	return !areInputsValid
		|| blockEditing
		|| (requiresOnChainVerification && !isOnChainInformationVerified)
		|| isBlockExplorerLookupPending
}

export type AddressIdentificationKey = {
	address: bigint
	chainId: ChainIdWithUniversal
	windowStateId: string
	includeSafeContractState: boolean
}

export function getAddressIdentificationKey(state: ModifyAddressWindowState): AddressIdentificationKey | undefined {
	if (!state.incompleteAddressBookEntry.addingAddress && state.incompleteAddressBookEntry.type !== 'safe') return undefined
	const address = stringToAddress(state.incompleteAddressBookEntry.address)
	if (address === undefined) return undefined
	return { address, chainId: state.incompleteAddressBookEntry.chainId, windowStateId: state.windowStateId, includeSafeContractState: state.incompleteAddressBookEntry.type === 'safe' }
}

export function areAddressIdentificationKeysEqual(left: AddressIdentificationKey | undefined, right: AddressIdentificationKey | undefined) {
	return left?.address === right?.address && left?.chainId === right?.chainId && left?.windowStateId === right?.windowStateId && left?.includeSafeContractState === right?.includeSafeContractState
}

export function isIdentificationRequestCurrent(state: ModifyAddressWindowState, requestedIdentification: AddressIdentificationKey) {
	return areAddressIdentificationKeysEqual(getAddressIdentificationKey(state), requestedIdentification)
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
	safeSignerLookupState: AsyncStates
	safeSignerAddressBookEntries: Signal<AddressBookEntries>
	fetchAbiAndNameFromBlockExplorer: () => Promise<void>
	refreshSafeSigners: () => void
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

function RenderIncompleteAddressBookEntry({ modifyAddressWindowState, rpcEntries, canFetchFromEtherScan, blockExplorerLookupState, safeSignerLookupState, safeSignerAddressBookEntries, fetchAbiAndNameFromBlockExplorer, refreshSafeSigners }: RenderinCompleteAddressBookParams) {
	const disableDueToSource = modifyAddressWindowState.value.incompleteAddressBookEntry.entrySource === 'DarkFloristMetadata' || modifyAddressWindowState.value.incompleteAddressBookEntry.entrySource === 'Interceptor'
	const logoUri = modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress === false && 'logoUri' in modifyAddressWindowState.value.incompleteAddressBookEntry ? modifyAddressWindowState.value.incompleteAddressBookEntry.logoUri : undefined
	const selectedChainId = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.chainId ?? 1n)
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

	const setAddress = async (address: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, previousEntry.type === 'safe' ? {
		address,
		safeSignerAddresses: [],
		safeSignerAddress: undefined,
		safeVersion: undefined,
	} : { address }))
	const setName = async (name: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { name }))
	const setChain = async (chainEntry: ChainEntry) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, previousEntry.type === 'safe' ? {
		chainId: chainEntry.chainId,
		safeSignerAddresses: [],
		safeSignerAddress: undefined,
		safeVersion: undefined,
	} : { chainId: chainEntry.chainId }))
	const setAbi = async (abi: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { abi: abi.trim().length === 0 ? undefined : abi }))
	const setSafeSignerAddress = async (safeSignerAddress: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { safeSignerAddress }))
	const setSymbol = async (symbol: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { symbol }))
	const setDecimals = async (inputEvent: Event) => updateIncompleteAddressBookEntry(previousEntry => {
		if (!(inputEvent.target instanceof HTMLInputElement) || inputEvent.target === null) return previousEntry
		const inputElement = inputEvent.target
		const decimals = inputElement.value
		const parseDecimalsString = () => {
			if (decimals.length === 0) return undefined
			const parsed = NonHexBigInt.safeParse(decimals)
			if (parsed.success && isValidErc20Decimals(parsed.value)) return parsed.value
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
	const safeSignerAddresses = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.safeSignerAddresses ?? [])
	const selectedSafeSignerAddress = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.safeSignerAddress ?? safeSignerAddresses.value[0] ?? '')
	const renderSafeSigner = (safeSignerAddress: string) => {
		const address = stringToAddress(safeSignerAddress)
		if (address === undefined) return safeSignerAddress
		return <span class = 'safe-signer-dropdown-address'><SmallAddress addressBookEntry = { getActiveAddressEntry(address, safeSignerAddressBookEntries.value) } renameAddressCallBack = { () => undefined } noCopying = { true } noEditAddress = { true } nonInteractive = { true }/></span>
	}
	const hasSafeSigners = safeSignerAddresses.value.length > 0
	return <div class = 'address-editor'>
		<div class = 'address-editor-fields'>
			<label class = 'address-editor-field address-editor-name-field'>
				<AddressIcon address = { stringToAddress(modifyAddressWindowState.value.incompleteAddressBookEntry.address) } logoUri = { logoUri } isBig = { true } backgroundColor = 'var(--text-color)'/>
				<span>Name</span>
				<NameInput nameInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.name } setNameInput = { setName } disabled = { disableDueToSource }/>
			</label>
			<div class = 'address-editor-identity-selectors'>
				<div class = 'address-editor-field'>
					<span>Address type:</span>
					<DropDownMenu selected = { selectedAddresBookEntryType } dropDownOptions = { addressBookEntryOptions } onChangedCallBack = { onTypeChangedCallBack } buttonClassses = { 'btn btn--outline is-small' } ariaLabel = 'Address type'/>
				</div>
				<div class = 'address-editor-field'>
					<span>Chain:</span>
					<ChainSelector rpcEntries = { rpcEntries } chainId = { selectedChainId } changeChain = { setChain } buttonClassses = { 'btn btn--outline is-small' } ariaLabel = 'Chain'/>
				</div>
			</div>
			<label class = { `address-editor-field address-editor-field--wide ${ modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? '' : 'address-editor-field--compact-address' }` }>
				<span>Address</span>
				{ modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress
					? <AddressInput disabled = { disableDueToSource } addressInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.address } setAddress = { setAddress } />
					: <code class = 'address-editor-readonly-address' title = { modifyAddressWindowState.value.incompleteAddressBookEntry.address }>{ modifyAddressWindowState.value.incompleteAddressBookEntry.address }</code>
				}
			</label>
			{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'safe' ? <section class = 'address-editor-section address-editor-field--wide'>
				<div class = 'address-editor-section-heading'>
					<p class = 'address-editor-heading'>Safe signer</p>
					<AsyncActionButton
						class = 'btn btn--outline is-small'
						state = { safeSignerLookupState }
						text = { hasSafeSigners ? 'Refresh signers' : 'Retrieve signers' }
						pendingText = { hasSafeSigners ? 'Refreshing...' : 'Retrieving...' }
						disabled = { disableDueToSource || stringToAddress(modifyAddressWindowState.value.incompleteAddressBookEntry.address) === undefined }
						onClick = { refreshSafeSigners }
					/>
				</div>
				{ hasSafeSigners
					? <div class = 'safe-signer-editor-dropdown'>
						<span>Signer owner</span>
						<DropDownMenu selected = { selectedSafeSignerAddress } dropDownOptions = { safeSignerAddresses } onChangedCallBack = { safeSignerAddress => { void setSafeSignerAddress(safeSignerAddress) } } buttonClassses = 'btn btn--outline is-small' ariaLabel = 'Safe signer owner' disabled = { disableDueToSource } renderOption = { renderSafeSigner }/>
					</div>
					: <p class = 'paragraph safe-signer-editor-empty'>Enter a deployed Safe address on a specific chain to retrieve its owners.</p>
				}
			</section> : <></> }
			{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' || modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC721' || modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC1155' ? <label class = 'address-editor-field'>
				<span>Symbol</span>
				<input disabled = { disableDueToSource } class = 'input subtitle is-7 is-spaced' type = 'text' value = { modifyAddressWindowState.value.incompleteAddressBookEntry.symbol } placeholder = '...' onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) setSymbol(e.target.value) } } />
			</label> : <></> }
			{ modifyAddressWindowState.value.incompleteAddressBookEntry.type === 'ERC20' ? <label class = 'address-editor-field'>
				<span>Decimals</span>
				<input disabled = { disableDueToSource } class = 'input subtitle is-7 is-spaced' type = 'text' inputMode = 'numeric' pattern = '[0-9]*' value = { decimals.value } placeholder = '...' onInput = { e => setDecimals(e) }/>
			</label> : <></> }
			<section class = 'address-editor-section address-editor-field--wide'>
				<div class = 'address-editor-section-heading'>
					<p class = 'address-editor-heading'>Contract ABI</p>
						<AsyncActionButton
							class = 'btn btn--outline is-small'
							state = { blockExplorerLookupState }
							text = 'Fetch from Block Explorer'
							pendingText = 'Fetching...'
							disabled = { stringToAddress(modifyAddressWindowState.value.incompleteAddressBookEntry.address) === undefined || !canFetchFromEtherScan.value || !blockExplorerAvailable.value }
							onClick = { fetchAbiAndNameFromBlockExplorer }
						/>
				</div>
				<AbiInput abiInput = { modifyAddressWindowState.value.incompleteAddressBookEntry.abi } setAbiInput = { setAbi } disabled = { false }/>
			</section>
		</div>
		<section class = 'address-editor-section address-editor-preferences'>
			<p class = 'address-editor-heading'>Usage preferences</p>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { modifyAddressWindowState.value.incompleteAddressBookEntry.useAsActiveAddress } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setUseAsActiveAddress(e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Use as active address</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { !modifyAddressWindowState.value.incompleteAddressBookEntry.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
				<p class = 'paragraph checkbox-text'>Don't request access when used as active address (insecure)</p>
			</label>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { 'declarativeNetRequestBlockMode' in modifyAddressWindowState.value.incompleteAddressBookEntry && modifyAddressWindowState.value.incompleteAddressBookEntry.declarativeNetRequestBlockMode === 'block-all' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setDeclarativeNetRequestBlockMode(e.target.checked ? 'block-all' : 'disabled') } } } />
				<p class = 'paragraph checkbox-text'>Block all external requests on site when this address is active (not recommended).</p>
			</label>
		</section>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const onChainInformationVerifiedByUser = useSignal<boolean>(false)
	const canFetchFromEtherScan = useSignal<boolean>(false)
	const lastCompletedIdentification = useSignal<AddressIdentificationKey | undefined>(undefined)
	const inFlightIdentifications = useSignal<readonly AddressIdentificationKey[]>([])
	const safeSignerRefreshGeneration = useSignal(0)
	const safeSignerAddressBookEntries = useSignal<AddressBookEntries>([])
	const { value: blockExplorerLookup, waitFor: waitForBlockExplorerLookup, reset: resetBlockExplorerLookup } = useAsyncState<void>()
	const { value: safeSignerLookup, waitFor: waitForSafeSignerLookup } = useAsyncState<void>()
	const { value: saveEntryState, waitFor: waitForSaveEntry } = useAsyncState<void>()
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
		safeSignerRefreshGeneration.value
		const setSafeContractStateError = (message: string) => {
			const currentState = param.modifyAddressWindowState.peek()
			param.modifyAddressWindowState.value = modifyObject(currentState, {
				errorState: { blockEditing: false, message },
			})
		}
		const identifyAddress = async (requestedIdentification: AddressIdentificationKey) => {
			inFlightIdentifications.value = [...inFlightIdentifications.peek(), requestedIdentification]
			try {
				const identifiedAddress = await requestPopupIdentifyAddress({
					address: requestedIdentification.address,
					chainId: requestedIdentification.chainId,
					includeSafeContractState: requestedIdentification.includeSafeContractState,
				})
				if (!isIdentificationRequestCurrent(param.modifyAddressWindowState.peek(), requestedIdentification)) return
				lastCompletedIdentification.value = requestedIdentification
				if (identifiedAddress === undefined || identifiedAddress.data.chainId !== requestedIdentification.chainId) {
					if (requestedIdentification.includeSafeContractState) setSafeContractStateError('Interceptor did not return the current Gnosis Safe signers.')
					return
				}
				const identifiedAddressBookEntry = identifiedAddress.data.addressBookEntry
				const safeContractState = identifiedAddress.data.safeContractState
				if (requestedIdentification.includeSafeContractState && safeContractState === undefined) {
					const message = requestedIdentification.chainId === 'AllChains'
						? 'Gnosis Safe wallets must use a specific chain to load their signers.'
						: `Switch Interceptor to chain ${ requestedIdentification.chainId.toString() } to load this Gnosis Safe's signers.`
					setSafeContractStateError(message)
				} else if (requestedIdentification.includeSafeContractState && safeContractState !== undefined) {
					if (!safeContractState.ok) {
						setSafeContractStateError(safeContractState.message)
						return
					}
					safeSignerAddressBookEntries.value = safeContractState.ownerAddressBookEntries
					const currentState = param.modifyAddressWindowState.peek()
					const safeSignerAddresses = safeContractState.owners.map(checksummedAddress)
					const currentSafeSignerAddress = currentState.incompleteAddressBookEntry.safeSignerAddress
					const safeSignerAddress = currentSafeSignerAddress === undefined
						? safeSignerAddresses[0]
						: safeSignerAddresses.find((address) => address.toLowerCase() === currentSafeSignerAddress.toLowerCase()) ?? safeSignerAddresses[0]
					param.modifyAddressWindowState.value = modifyObject(currentState, {
						incompleteAddressBookEntry: modifyObject(currentState.incompleteAddressBookEntry, {
							safeSignerAddresses,
							safeSignerAddress,
							safeVersion: safeContractState.version,
						}),
						errorState: undefined,
					})
				}
				if (identifiedAddressBookEntry?.type === 'ERC20') {
					const currentState = param.modifyAddressWindowState.peek()
					param.modifyAddressWindowState.value = modifyObject(currentState, { incompleteAddressBookEntry: {
						...currentState.incompleteAddressBookEntry,
						name: identifiedAddressBookEntry.name,
						decimals: identifiedAddressBookEntry.decimals,
					} })
				}
			} finally {
				inFlightIdentifications.value = inFlightIdentifications.peek().filter((identification) => !areAddressIdentificationKeysEqual(identification, requestedIdentification))
			}
		}
		const currentIdentification = getAddressIdentificationKey(param.modifyAddressWindowState.value)
		if (currentIdentification === undefined || areAddressIdentificationKeysEqual(lastCompletedIdentification.value, currentIdentification)) return
		if (inFlightIdentifications.value.some((identification) => areAddressIdentificationKeysEqual(identification, currentIdentification))) return
		if (currentIdentification.includeSafeContractState) {
			void waitForSafeSignerLookup(async () => await identifyAddress(currentIdentification))
			return
		}
		void identifyAddress(currentIdentification)
	})

	const refreshSafeSigners = () => {
		safeSignerRefreshGeneration.value += 1
		lastCompletedIdentification.value = undefined
	}

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
				if (!isValidErc20Decimals(incompleteAddressBookEntry.decimals)) return { type: 'error', error: 'Decimals must be between 0 and 255' }
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
		if (isSubmitButtonDisabled.peek()) return
		await waitForSaveEntry(async () => {
			const entryToAdd = getCompleteAddressBookEntry()
			const saveError = await saveAddressBookEntry(entryToAdd, param.close)
			if (saveError === undefined) return
			param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { errorState: { blockEditing: false, message: saveError } })
		})
	}

	async function createAndSwitch() {
		if (isSubmitButtonDisabled.peek()) return
		await waitForSaveEntry(async () => {
			const entryToAdd = getCompleteAddressBookEntry()
			const saveError = await saveAddressBookEntryAndSwitch(entryToAdd, param.close, param.setActiveAddressAndInformAboutIt)
			if (saveError === undefined) return
			param.modifyAddressWindowState.value = modifyObject(param.modifyAddressWindowState.value, { errorState: { blockEditing: false, message: saveError } })
		})
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
		return saveEntryState.value.state === 'pending' || isAddressBookSubmissionDisabled({
			areInputsValid: areInputsValid.value,
			blockEditing: param.modifyAddressWindowState.value.errorState?.blockEditing === true,
			requiresOnChainVerification: showOnChainVerificationErrorBox.value,
			isOnChainInformationVerified: onChainInformationVerifiedByUser.value,
			isBlockExplorerLookupPending: isBlockExplorerLookupPending.value,
		})
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
						<img src = '../img/address-book.svg' width = '24' height = '24'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p class = 'paragraph'> { getCardTitle() } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close } disabled = { isBlockExplorerLookupPending.value }>
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
							blockExplorerLookupState = { blockExplorerLookup.value.state }
							safeSignerLookupState = { safeSignerLookup.value.state }
							safeSignerAddressBookEntries = { safeSignerAddressBookEntries }
							fetchAbiAndNameFromBlockExplorer = { fetchAbiAndNameFromBlockExplorer }
							refreshSafeSigners = { refreshSafeSigners }
						/>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ completeAddressBookEntryOrError.value.type !== 'error' ? <></> : <ErrorText text = { completeAddressBookEntryOrError.value.error } /> }

					{ param.modifyAddressWindowState.value.errorState === undefined ? <></> : <ErrorText text = { param.modifyAddressWindowState.value.errorState.message } /> }
					{ saveEntryState.value.state === 'rejected' ? <ErrorText text = { saveEntryState.value.error.message } /> : <></> }
					{ !showOnChainVerificationErrorBox.value ? <></> :
						<ErrorCheckBox
							text = { `The name and symbol for this token was provided by the token itself and we have not validated its legitimacy. A token may claim to have a name/symbol that is the same as another popular token (e.g., USDC or DAI) in an attempt to trick you. If you recognize this token's name, please verify elsewhere that this is the correct address for it.` }
							checked = { onChainInformationVerifiedByUser }
						/>
					}
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				{ param.setActiveAddressAndInformAboutIt === undefined || param.modifyAddressWindowState.value.incompleteAddressBookEntry === undefined || activeAddress.value === stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) ? <></> : <AsyncActionButton class = 'button is-success is-primary' state = { saveEntryState.value.state } onClick = { createAndSwitch } disabled = { isSubmitButtonDisabled.value } text = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } pendingText = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Creating and switching...' : 'Modifying and switching...' } /> }
				<AsyncActionButton class = 'button is-success is-primary' state = { saveEntryState.value.state } onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled.value } text = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create' : 'Modify' } pendingText = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Creating...' : 'Modifying...' } />
				<button class = 'button is-primary' style = 'background-color: var(--negative-color)' onClick = { param.close } disabled = { isBlockExplorerLookupPending.value }>Cancel</button>
			</footer>
		</div>
	</> )
}
