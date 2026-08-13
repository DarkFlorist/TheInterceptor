import { isAddress } from '../../utils/ethereumPrimitives.js'
import { useEffect } from 'preact/hooks'
import type { AddAddressParam } from '../../types/user-interface-types.js'
import { ErrorCheckBox, ErrorText } from '../subcomponents/Error.js'
import { checksummedAddress, stringToAddress } from '../../utils/bigint.js'
import { getMissingPopupReplyErrorMessage, requestPopupAbiAndNameFromBlockExplorer, requestPopupIdentifyAddress, requestPopupSafeContractState, sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { AddressIcon, getActiveAddressEntry, SmallAddress } from '../subcomponents/address.js'
import { assertUnreachable, modifyObject } from '../../utils/typescript.js'
import { createRef } from 'preact'
import type { AddressBookEntries, AddressBookEntry, AddressBookEntryType, ChainIdWithUniversal, DeclarativeNetRequestBlockMode } from '../../types/addressBookTypes.js'
import { isBlockExplorerAvailableForChain, isValidAbi } from '../../simulation/services/EtherScanAbiFetcher.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { ChevronIcon, XMarkIcon } from '../subcomponents/icons.js'
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
	requestSafeContractState: boolean
}

export function getAddressIdentificationKey(state: ModifyAddressWindowState): AddressIdentificationKey | undefined {
	if (!state.incompleteAddressBookEntry.addingAddress && state.incompleteAddressBookEntry.type !== 'safe') return undefined
	const address = stringToAddress(state.incompleteAddressBookEntry.address)
	if (address === undefined) return undefined
	return { address, chainId: state.incompleteAddressBookEntry.chainId, windowStateId: state.windowStateId, requestSafeContractState: state.incompleteAddressBookEntry.type === 'safe' }
}

export function areAddressIdentificationKeysEqual(left: AddressIdentificationKey | undefined, right: AddressIdentificationKey | undefined) {
	return left?.address === right?.address && left?.chainId === right?.chainId && left?.windowStateId === right?.windowStateId && left?.requestSafeContractState === right?.requestSafeContractState
}

export function isIdentificationRequestCurrent(state: ModifyAddressWindowState, requestedIdentification: AddressIdentificationKey) {
	return areAddressIdentificationKeysEqual(getAddressIdentificationKey(state), requestedIdentification)
}

export async function persistAddressBookEntry(entryToAdd: AddressBookEntry | { type: 'error', error: string }, sendMessage: (message: { method: 'popup_addOrModifyAddressBookEntry', data: AddressBookEntry }) => Promise<{ readonly ok: boolean, readonly message?: string } | undefined> = sendPopupMessageWithReply) {
	if (entryToAdd.type === 'error') return
	const reply = await sendMessage({ method: 'popup_addOrModifyAddressBookEntry', data: entryToAdd })
	if (reply === undefined) return 'Interceptor did not reply while validating the address-book entry.'
	if (reply.ok === false) return reply.message ?? 'Failed to save address-book entry.'
	return undefined
}

export async function saveAddressBookEntry(entryToAdd: AddressBookEntry | { type: 'error', error: string }, close: () => void, sendMessage: (message: { method: 'popup_addOrModifyAddressBookEntry', data: AddressBookEntry }) => Promise<{ readonly ok: boolean, readonly message?: string } | undefined> = sendPopupMessageWithReply,
) {
	const saveError = await persistAddressBookEntry(entryToAdd, sendMessage)
	if (saveError !== undefined || entryToAdd.type === 'error') return saveError
	close()
	return undefined
}

export async function saveAddressBookEntryAndSwitch(
	entryToAdd: AddressBookEntry | { type: 'error', error: string },
	close: () => void,
	setActiveAddressAndInformAboutIt: ((address: bigint, persistedEntry: AddressBookEntry) => Promise<void>) | undefined,
	sendMessage: (message: { method: 'popup_addOrModifyAddressBookEntry', data: AddressBookEntry }) => Promise<{ readonly ok: boolean, readonly message?: string } | undefined> = sendPopupMessageWithReply,
) {
	if (entryToAdd.type === 'error') return entryToAdd.error
	const saveError = await persistAddressBookEntry(entryToAdd, sendMessage)
	if (saveError !== undefined) return saveError
	await setActiveAddressAndInformAboutIt?.(entryToAdd.address, entryToAdd)
	close()
	return undefined
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
		class = 'input address-editor-name-input'
		type = 'text'
		aria-label = 'Name'
		value = { nameInput }
		onInput = { e => setNameInput((e.target as HTMLInputElement).value) }
		maxLength = { MAX_ADDRESS_BOOK_ENTRY_NAME_LENGTH }
		ref = { ref }
		disabled = { disabled }
	/>
}

type AddressInputParams = {
	disabled: boolean
	addressInput: string | undefined
	setAddress: (input: string) => void
	ariaLabel?: string
}

function AddressInput({ disabled, addressInput, setAddress, ariaLabel = 'Address' }: AddressInputParams) {
	return <textarea
		disabled = { disabled }
		class = 'input address-editor-address-input'
		rows = { 1 }
		spellcheck = { false }
		aria-label = { ariaLabel }
		value = { addressInput }
		placeholder = { '0x0...' }
		onInput = { e => setAddress(e.currentTarget.value.replaceAll('\n', '').replaceAll('\r', '')) }
		style = { addressInput === undefined || isAddress(addressInput.trim()) ? undefined : 'color: var(--negative-color);' }
	/>
}

type RenderinCompleteAddressBookParams = {
	modifyAddressWindowState: Signal<ModifyAddressWindowState>
	rpcEntries: Signal<RpcEntries>
	canFetchFromEtherScan: Signal<boolean>
	blockExplorerLookupState: AsyncStates
	safeSignerLookupState: AsyncStates
	safeSimulationSignerAddressBookEntries: Signal<AddressBookEntries>
	fetchAbiAndNameFromBlockExplorer: () => Promise<void>
	refreshSafeSigners: () => void
}

type AbiInputParams = {
	abiInput: string | undefined
	setAbiInput: (input: string) => void
	disabled: boolean,
}

function AbiInput({ abiInput, setAbiInput, disabled }: AbiInputParams) {
	return <input
		class = 'input address-editor-abi-input'
		type = 'text'
		aria-label = 'ABI'
		value = { abiInput }
		placeholder = { 'no abi' }
		onInput = { e => setAbiInput(e.currentTarget.value) }
		disabled = { disabled }
		style = { abiInput === undefined || isValidAbi(abiInput.trim()) ? undefined : 'color: var(--negative-color);' }
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

function RenderIncompleteAddressBookEntry({ modifyAddressWindowState, rpcEntries, canFetchFromEtherScan, blockExplorerLookupState, safeSignerLookupState, safeSimulationSignerAddressBookEntries, fetchAbiAndNameFromBlockExplorer, refreshSafeSigners }: RenderinCompleteAddressBookParams) {
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
		safeSimulationSignerAddress: undefined,
		safeVersion: undefined,
	} : { address }))
	const setName = async (name: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { name }))
	const setChain = async (chainEntry: ChainEntry) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, previousEntry.type === 'safe' ? {
		chainId: chainEntry.chainId,
		safeSignerAddresses: [],
		safeSimulationSignerAddress: undefined,
		safeVersion: undefined,
	} : { chainId: chainEntry.chainId }))
	const setAbi = async (abi: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { abi: abi.trim().length === 0 ? undefined : abi }))
	const setSafeSignerAddress = async (safeSimulationSignerAddress: string) => updateIncompleteAddressBookEntry(previousEntry => modifyObject(previousEntry, { safeSimulationSignerAddress }))
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
	const selectedSafeSignerAddress = useComputed(() => modifyAddressWindowState.value.incompleteAddressBookEntry.safeSimulationSignerAddress ?? safeSignerAddresses.value[0] ?? '')
	const hasSafeSigners = safeSignerAddresses.value.length > 0
	const entry = modifyAddressWindowState.value.incompleteAddressBookEntry
	return <div class = 'address-editor'>
		<div class = 'address-editor-fields'>
			<div class = 'address-editor-identity'>
				<div class = 'address-editor-primary-identity'>
					<div class = 'address-editor-address-icon'>
						<AddressIcon address = { stringToAddress(entry.address) } logoUri = { logoUri } isBig = { true } backgroundColor = 'var(--text-color)'/>
					</div>
					<div class = 'address-editor-identity-controls'>
						<label class = 'address-editor-field address-editor-name-field'>
							<span>Name</span>
							<NameInput nameInput = { entry.name } setNameInput = { setName } disabled = { disableDueToSource }/>
						</label>
						<div class = 'address-editor-field address-editor-type-field'>
							<span>Address type</span>
							<DropDownMenu selected = { selectedAddresBookEntryType } dropDownOptions = { addressBookEntryOptions } onChangedCallBack = { onTypeChangedCallBack } buttonClassses = { 'btn btn--outline is-small' } ariaLabel = 'Address type'/>
						</div>
						<div class = 'address-editor-field address-editor-chain-field'>
							<span>Chain</span>
							<ChainSelector rpcEntries = { rpcEntries } chainId = { selectedChainId } changeChain = { setChain } buttonClassses = { 'btn btn--outline is-small' } ariaLabel = 'Chain'/>
						</div>
					</div>
				</div>
				<label class = 'address-editor-field address-editor-address-field'>
					<span>Address</span>
					{ entry.addingAddress
						? <AddressInput disabled = { disableDueToSource } addressInput = { entry.address } setAddress = { setAddress } />
						: <code class = 'address-editor-readonly-address' title = { entry.address }>{ entry.address }</code>
					}
				</label>
			</div>
			{ entry.type === 'safe' ? <section class = 'address-editor-section address-editor-field--wide address-editor-safe-section'>
				<div class = 'address-editor-section-heading'>
					<p class = 'address-editor-heading'>Safe owners{ hasSafeSigners ? ` · ${ safeSignerAddresses.value.length }` : '' }</p>
					<AsyncActionButton
						class = 'btn btn--outline is-small'
						state = { safeSignerLookupState }
						text = 'Refresh owners'
						pendingText = { hasSafeSigners ? 'Refreshing...' : 'Retrieving...' }
						disabled = { disableDueToSource || stringToAddress(entry.address) === undefined }
						onClick = { refreshSafeSigners }
					/>
				</div>
				{ hasSafeSigners
					? <div class = 'safe-signer-owner-picker'>
						<p>Safe signer in simulation</p>
						<div class = 'safe-signer-owner-list' role = 'radiogroup' aria-label = 'Safe signer in simulation'>
							{ safeSignerAddresses.value.map((safeSignerAddress) => {
								const parsedAddress = stringToAddress(safeSignerAddress)
								if (parsedAddress === undefined) return <></>
								const addressBookEntry = getActiveAddressEntry(parsedAddress, safeSimulationSignerAddressBookEntries.value)
								return <label class = 'safe-signer-owner-option' key = { safeSignerAddress }>
									<input type = 'radio' name = 'safe-simulation-signer' value = { safeSignerAddress } checked = { selectedSafeSignerAddress.value.toLowerCase() === safeSignerAddress.toLowerCase() } disabled = { disableDueToSource } onChange = { () => { void setSafeSignerAddress(safeSignerAddress) } } />
									<SmallAddress addressBookEntry = { addressBookEntry } renameAddressCallBack = { () => undefined } noEditAddress = { true } nonInteractive = { true } />
								</label>
							}) }
						</div>
					</div>
					: <></>
				}
			</section> : <></> }
			{ entry.type === 'ERC20' || entry.type === 'ERC721' || entry.type === 'ERC1155' ? <div class = 'address-editor-token-fields address-editor-field--wide'>
				<label class = 'address-editor-field'>
					<span>Symbol</span>
					<input disabled = { disableDueToSource } class = 'input' type = 'text' value = { entry.symbol } placeholder = 'Token symbol' onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) setSymbol(e.target.value) } } />
				</label>
				{ entry.type === 'ERC20' ? <label class = 'address-editor-field'>
					<span>Decimals</span>
					<input disabled = { disableDueToSource } class = 'input' type = 'text' inputMode = 'numeric' pattern = '[0-9]*' value = { decimals.value } placeholder = '18' onInput = { e => setDecimals(e) }/>
				</label> : <></> }
			</div> : <></> }
			<details class = 'address-editor-disclosure address-editor-field--wide' open = { entry.abi !== undefined }>
				<summary>
					<strong>Advanced details</strong>
					<span class = 'address-editor-disclosure-chevron' aria-hidden = 'true'><ChevronIcon /></span>
				</summary>
				<div class = 'address-editor-disclosure-content'>
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
					<AbiInput abiInput = { entry.abi } setAbiInput = { setAbi } disabled = { false }/>
				</div>
			</details>
		</div>
		<section class = 'address-editor-preferences'>
			<div class = 'address-editor-preferences-heading'>
				<p class = 'address-editor-heading'>Usage preferences</p>
				<label class = 'address-editor-setting address-editor-setting--primary'>
					<span>Use as active address</span>
					<input role = 'switch' type = 'checkbox' checked = { entry.useAsActiveAddress } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setUseAsActiveAddress(e.target.checked) } } } />
				</label>
			</div>
			<details class = 'address-editor-preference-disclosure'>
				<summary>
					<span>Privacy and site controls</span>
					<span class = 'address-editor-disclosure-chevron' aria-hidden = 'true'><ChevronIcon /></span>
				</summary>
				<div class = 'address-editor-preference-content'>
					<label class = 'address-editor-setting'>
						<span><strong>Skip access requests</strong><small>Sites see this address without asking user</small></span>
						<input role = 'switch' type = 'checkbox' checked = { !entry.askForAddressAccess } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setAskForAddressAccess(!e.target.checked) } } } />
					</label>
					<label class = 'address-editor-setting'>
						<span><strong>Block external site requests</strong><small>May prevent parts of the site from loading.</small></span>
						<input role = 'switch' type = 'checkbox' checked = { 'declarativeNetRequestBlockMode' in entry && entry.declarativeNetRequestBlockMode === 'block-all' } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { setDeclarativeNetRequestBlockMode(e.target.checked ? 'block-all' : 'disabled') } } } />
					</label>
				</div>
			</details>
		</section>
	</div>
}

export function AddNewAddress(param: AddAddressParam) {
	const activeAddress = useSignal<bigint | undefined>(undefined)
	const onChainInformationVerifiedByUser = useSignal<boolean>(false)
	const canFetchFromEtherScan = useSignal<boolean>(false)
	const lastCompletedIdentification = useSignal<AddressIdentificationKey | undefined>(undefined)
	const lastSuccessfulSafeIdentification = useSignal<AddressIdentificationKey | undefined>(undefined)
	const inFlightIdentifications = useSignal<readonly AddressIdentificationKey[]>([])
	const safeSignerRefreshGeneration = useSignal(0)
	const safeSimulationSignerAddressBookEntries = useSignal<AddressBookEntries>([])
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
				const [identifiedAddress, safeContractStateReply] = await Promise.all([
					requestPopupIdentifyAddress({ address: requestedIdentification.address, chainId: requestedIdentification.chainId }),
					requestedIdentification.requestSafeContractState
						? requestPopupSafeContractState({ address: requestedIdentification.address, chainId: requestedIdentification.chainId })
						: Promise.resolve(undefined),
				])
				if (!isIdentificationRequestCurrent(param.modifyAddressWindowState.peek(), requestedIdentification)) return
				lastCompletedIdentification.value = requestedIdentification
				const identifiedAddressBookEntry = identifiedAddress?.data.chainId === requestedIdentification.chainId ? identifiedAddress.data.addressBookEntry : undefined
				if (requestedIdentification.requestSafeContractState && (safeContractStateReply === undefined || safeContractStateReply.data.chainId !== requestedIdentification.chainId)) {
					setSafeContractStateError('Interceptor did not return the current Gnosis Safe signers.')
				} else if (requestedIdentification.requestSafeContractState && safeContractStateReply !== undefined) {
					const safeContractState = safeContractStateReply.data.result
					if (!safeContractState.ok) {
						setSafeContractStateError(safeContractState.message)
						return
					}
					lastSuccessfulSafeIdentification.value = requestedIdentification
					safeSimulationSignerAddressBookEntries.value = safeContractState.ownerAddressBookEntries
					const currentState = param.modifyAddressWindowState.peek()
					const safeSignerAddresses = safeContractState.owners.map(checksummedAddress)
					const currentSafeSignerAddress = currentState.incompleteAddressBookEntry.safeSimulationSignerAddress
					const safeSimulationSignerAddress = currentSafeSignerAddress === undefined
						? safeSignerAddresses[0]
						: safeSignerAddresses.find((address) => address.toLowerCase() === currentSafeSignerAddress.toLowerCase()) ?? safeSignerAddresses[0]
					param.modifyAddressWindowState.value = modifyObject(currentState, {
						incompleteAddressBookEntry: modifyObject(currentState.incompleteAddressBookEntry, {
							safeSignerAddresses,
							safeSimulationSignerAddress,
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
		if (currentIdentification.requestSafeContractState) {
			void waitForSafeSignerLookup(async () => await identifyAddress(currentIdentification))
			return
		}
		void identifyAddress(currentIdentification)
	})

	const refreshSafeSigners = () => {
		safeSignerRefreshGeneration.value += 1
		lastCompletedIdentification.value = undefined
		lastSuccessfulSafeIdentification.value = undefined
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
		const safeSimulationSignerAddressStrings = (incompleteAddressBookEntry.safeSignerAddresses ?? [])
			.map((address) => address.trim())
			.filter((address) => address.length > 0)
		const safeSignerAddresses = safeSimulationSignerAddressStrings.map(stringToAddress)
		if (incompleteAddressBookEntry.type === 'safe' && safeSignerAddresses.some((address) => address === undefined)) return { type: 'error', error: 'A Gnosis Safe signer address is not valid' }
		const parsedSafeSignerAddresses = safeSignerAddresses.filter((address): address is bigint => address !== undefined)
		const requestedSafeSignerAddress = stringToAddress(incompleteAddressBookEntry.safeSimulationSignerAddress)
		if (incompleteAddressBookEntry.type === 'safe' && incompleteAddressBookEntry.safeSimulationSignerAddress !== undefined && requestedSafeSignerAddress === undefined) return { type: 'error', error: 'Default Gnosis Safe simulation signer address is not valid' }
		const safeSimulationSignerAddress = requestedSafeSignerAddress ?? parsedSafeSignerAddresses[0]
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
				if (parsedSafeSignerAddresses.length === 0) return { type: 'error', error: 'Gnosis Safe owner metadata is unavailable.' }
				if (safeSimulationSignerAddress === undefined || !parsedSafeSignerAddresses.includes(safeSimulationSignerAddress)) return { type: 'error', error: 'Select a current Gnosis Safe owner for simulation.' }
				if (incompleteAddressBookEntry.safeVersion === undefined) return { type: 'error', error: 'Retrieve the current Gnosis Safe version before saving.' }
				return {
					...base,
					type: 'safe' as const,
					chainId: incompleteAddressBookEntry.chainId,
					useAsActiveAddress: true,
					safeSimulationSignerAddress,
					safeSignerAddresses: Array.from(new Set(parsedSafeSignerAddresses)),
					safeVersion: incompleteAddressBookEntry.safeVersion,
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
	const isCurrentSafeLookupComplete = useComputed(() => {
		const currentIdentification = getAddressIdentificationKey(param.modifyAddressWindowState.value)
		return currentIdentification?.requestSafeContractState !== true
			|| areAddressIdentificationKeysEqual(lastSuccessfulSafeIdentification.value, currentIdentification)
	})

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
		return saveEntryState.value.state === 'pending' || !isCurrentSafeLookupComplete.value || isAddressBookSubmissionDisabled({
			areInputsValid: areInputsValid.value,
			blockEditing: param.modifyAddressWindowState.value.errorState?.blockEditing === true,
			requiresOnChainVerification: showOnChainVerificationErrorBox.value,
			isOnChainInformationVerified: onChainInformationVerifiedByUser.value,
			isBlockExplorerLookupPending: isBlockExplorerLookupPending.value,
		})
	})

	function getCardTitle() {
		const incompleteAddressBookEntry = param.modifyAddressWindowState.value.incompleteAddressBookEntry
		return incompleteAddressBookEntry.addingAddress ? 'Add address' : 'Edit address'
	}
	const incompleteAddressBookEntry = useComputed(() => param.modifyAddressWindowState.value.incompleteAddressBookEntry )
	return ( <>
		<div class = 'modal-background'> </div>
			<div class = 'modal-card address-editor-modal'>
				<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
					<div class = 'card-header-title'>
						<p class = 'paragraph'> { getCardTitle() } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close } disabled = { isBlockExplorerLookupPending.value }>
					<XMarkIcon />
				</button>
				</header>
				<section class = 'modal-card-body'>
					<RenderIncompleteAddressBookEntry
								modifyAddressWindowState = { param.modifyAddressWindowState }
							rpcEntries = { param.rpcEntries }
							canFetchFromEtherScan = { canFetchFromEtherScan }
							blockExplorerLookupState = { blockExplorerLookup.value.state }
							safeSignerLookupState = { safeSignerLookup.value.state }
							safeSimulationSignerAddressBookEntries = { safeSimulationSignerAddressBookEntries }
							fetchAbiAndNameFromBlockExplorer = { fetchAbiAndNameFromBlockExplorer }
								refreshSafeSigners = { refreshSafeSigners }
						/>
					<div class = 'address-editor-errors'>
					{ completeAddressBookEntryOrError.value.type !== 'error' || !isCurrentSafeLookupComplete.value ? <></> : <ErrorText text = { completeAddressBookEntryOrError.value.error } /> }

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
				<footer class = 'modal-card-foot window-footer address-editor-footer'>
					<button class = 'btn btn--outline' onClick = { param.close } disabled = { isBlockExplorerLookupPending.value }>Cancel</button>
					{ param.setActiveAddressAndInformAboutIt === undefined || param.modifyAddressWindowState.value.incompleteAddressBookEntry === undefined || activeAddress.value === stringToAddress(param.modifyAddressWindowState.value.incompleteAddressBookEntry.address) ? <></> : <AsyncActionButton class = 'btn btn--outline' state = { saveEntryState.value.state } onClick = { createAndSwitch } disabled = { isSubmitButtonDisabled.value } text = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create and switch' : 'Modify and switch' } pendingText = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Creating and switching...' : 'Modifying and switching...' } /> }
					<AsyncActionButton class = 'btn btn--primary' state = { saveEntryState.value.state } onClick = { modifyOrAddEntry } disabled = { isSubmitButtonDisabled.value } text = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Create address' : 'Save changes' } pendingText = { param.modifyAddressWindowState.value.incompleteAddressBookEntry.addingAddress ? 'Creating...' : 'Saving...' } />
				</footer>
		</div>
	</> )
}
