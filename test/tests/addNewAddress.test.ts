import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { areAddressIdentificationKeysEqual, getAddressIdentificationKey, isAddressBookSubmissionDisabled, isIdentificationRequestCurrent, mergeAddressWindowErrorState, saveAddressBookEntry, saveAddressBookEntryAndSwitch, updateModifyAddressWindowState } from '../../app/ts/components/pages/AddNewAddress.js'
import type { ModifyAddressWindowState } from '../../app/ts/types/visualizer-types.js'
import { EthereumQuantityUint8 } from '../../app/ts/types/wire-types.js'
import { isValidErc20Decimals } from '../../app/ts/utils/erc20.js'

const sampleAddressBookEntry = {
	type: 'contact',
	name: 'Alice',
	address: 1n,
	entrySource: 'User',
} as const
const addNewAddressSource = await Bun.file(new URL('../../app/ts/components/pages/AddNewAddress.tsx', import.meta.url)).text()
const safeContractStateSource = await Bun.file(new URL('../../app/ts/background/safeContractState.ts', import.meta.url)).text()
const serviceLifecycleSource = await Bun.file(new URL('../../app/ts/simulation/serviceLifecycle.ts', import.meta.url)).text()
const metadataUtilsSource = await Bun.file(new URL('../../app/ts/background/metadataUtils.ts', import.meta.url)).text()
const popupMessageHandlersSource = await Bun.file(new URL('../../app/ts/background/popupMessageHandlers.ts', import.meta.url)).text()
const replyMessagesSource = await Bun.file(new URL('../../app/ts/types/interceptor-reply-messages.ts', import.meta.url)).text()
const screenshotScriptSource = await Bun.file(new URL('../../scripts/capture-safe-ui-screenshots.mts', import.meta.url)).text()

describe('add new address save flow', () => {
	test('waits for the save message to finish before closing the popup', async () => {
		const calls: string[] = []
		await saveAddressBookEntry(sampleAddressBookEntry, () => {
			calls.push('close')
		}, async () => {
			calls.push('send:start')
			await Promise.resolve()
			calls.push('send:end')
			return { ok: true }
		})

		assert.deepEqual(calls, ['send:start', 'send:end', 'close'])
	})

	test('does not close the popup when the entry is invalid', async () => {
		let closed = false
		let sent = false

		await saveAddressBookEntry({ type: 'error', error: 'invalid' }, () => {
			closed = true
		}, async () => {
			sent = true
		})

		assert.equal(sent, false)
		assert.equal(closed, false)
	})

	test('shows backend Safe validation errors without closing the popup', async () => {
		let closed = false
		const message = await saveAddressBookEntry(sampleAddressBookEntry, () => {
			closed = true
		}, async () => ({
			ok: false,
			message: 'The configured address is not an owner of this Safe.',
		}))

		assert.equal(closed, false)
		assert.equal(message, 'The configured address is not an owner of this Safe.')
	})

	test('does not close when the background validation reply is missing', async () => {
		let closed = false
		const message = await saveAddressBookEntry(sampleAddressBookEntry, () => {
			closed = true
		}, async () => undefined)

		assert.equal(closed, false)
		assert.equal(message, 'Interceptor did not reply while validating the address-book entry.')
	})

	test('does not switch accounts when backend validation rejects the entry', async () => {
		let closed = false
		let switchedTo: bigint | undefined

		const message = await saveAddressBookEntryAndSwitch(
			sampleAddressBookEntry,
			() => { closed = true },
			async (address) => { switchedTo = address },
			async () => ({
				ok: false,
				message: 'The configured address is not an owner of this Safe.',
			}),
		)

		assert.equal(closed, false)
		assert.equal(switchedTo, undefined)
		assert.equal(message, 'The configured address is not an owner of this Safe.')
	})

	test('keeps the modal open until switching finishes', async () => {
		const calls: string[] = []
		let finishSwitch: (() => void) | undefined
		const switchFinished = new Promise<void>((resolve) => { finishSwitch = resolve })
		const saving = saveAddressBookEntryAndSwitch(
			sampleAddressBookEntry,
			() => { calls.push('close') },
			async () => {
				calls.push('switch:start')
				await switchFinished
				calls.push('switch:end')
			},
			async () => {
				calls.push('save')
				return { ok: true }
			},
		)
		await Promise.resolve()
		assert.deepEqual(calls, ['save'])
		await Promise.resolve()
		assert.deepEqual(calls, ['save', 'switch:start'])
		finishSwitch?.()
		await saving
		assert.deepEqual(calls, ['save', 'switch:start', 'switch:end', 'close'])
	})

	test('does not close when switching fails', async () => {
		let closed = false
		await assert.rejects(saveAddressBookEntryAndSwitch(
			sampleAddressBookEntry,
			() => { closed = true },
			async () => { throw new Error('Switch failed') },
			async () => ({ ok: true }),
		), /Switch failed/u)
		assert.equal(closed, false)
	})

	test('applies every submission safety gate to create-and-switch', () => {
		const validState = {
			areInputsValid: true,
			blockEditing: false,
			requiresOnChainVerification: false,
			isOnChainInformationVerified: false,
			isBlockExplorerLookupPending: false,
		}
		assert.equal(isAddressBookSubmissionDisabled(validState), false)
		assert.equal(isAddressBookSubmissionDisabled({ ...validState, areInputsValid: false }), true)
		assert.equal(isAddressBookSubmissionDisabled({ ...validState, blockEditing: true }), true)
		assert.equal(isAddressBookSubmissionDisabled({ ...validState, requiresOnChainVerification: true }), true)
		assert.equal(isAddressBookSubmissionDisabled({ ...validState, requiresOnChainVerification: true, isOnChainInformationVerified: true }), false)
		assert.equal(isAddressBookSubmissionDisabled({ ...validState, isBlockExplorerLookupPending: true }), true)
	})

	test('ignores token identification replies for an address or window that has changed', () => {
		const state: ModifyAddressWindowState = {
			windowStateId: 'current-window',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				type: 'ERC20',
				address: '0x0000000000000000000000000000000000000002',
				askForAddressAccess: true,
				name: undefined,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User',
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		}

		const requestedIdentification = getAddressIdentificationKey(state)
		if (requestedIdentification === undefined) throw new Error('Expected a valid identification key')
		assert.equal(isIdentificationRequestCurrent(state, requestedIdentification), true)
		assert.equal(isIdentificationRequestCurrent({ ...state, windowStateId: 'new-window' }, requestedIdentification), false)
		const changedAddressState = { ...state, incompleteAddressBookEntry: { ...state.incompleteAddressBookEntry, address: '0x0000000000000000000000000000000000000001' } }
		assert.equal(isIdentificationRequestCurrent(changedAddressState, requestedIdentification), false)
	})

	test('rechecks the same address after its selected chain changes', () => {
		const state: ModifyAddressWindowState = {
			windowStateId: 'current-window',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: true,
				type: 'ERC20',
				address: '0x0000000000000000000000000000000000000002',
				askForAddressAccess: true,
				name: undefined,
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User',
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			},
		}
		const requestedIdentification = getAddressIdentificationKey(state)
		const changedChainState = { ...state, incompleteAddressBookEntry: { ...state.incompleteAddressBookEntry, chainId: 10n } }
		const changedChainIdentification = getAddressIdentificationKey(changedChainState)
		if (requestedIdentification === undefined || changedChainIdentification === undefined) throw new Error('Expected valid identification keys')

		assert.equal(isIdentificationRequestCurrent(changedChainState, requestedIdentification), false)
		assert.equal(areAddressIdentificationKeysEqual(requestedIdentification, changedChainIdentification), false)
	})

	test('limits ERC-20 decimals to the uint8 range', () => {
		assert.equal(isValidErc20Decimals(0n), true)
		assert.equal(isValidErc20Decimals(255n), true)
		assert.equal(isValidErc20Decimals(256n), false)
		assert.equal(EthereumQuantityUint8.safeParse('0xff').success, true)
		assert.equal(EthereumQuantityUint8.safeParse('0x100').success, false)
		assert.equal(EthereumQuantityUint8.safeSerialize(255n).success, true)
		assert.equal(EthereumQuantityUint8.safeSerialize(256n).success, false)
	})

	test('shows the required symbol field for every token address type', () => {
		assert.match(addNewAddressSource, /entry\.type === 'ERC20' \|\| entry\.type === 'ERC721' \|\| entry\.type === 'ERC1155'/)
	})

	test('keeps non-blocking block explorer errors when validation has no error', () => {
		const blockExplorerError = { blockEditing: false, message: 'No ABI available for this contract.' }

		assert.deepEqual(mergeAddressWindowErrorState(blockExplorerError, undefined), blockExplorerError)
	})

	test('clears blocking validation errors when validation has no error', () => {
		const validationError = { blockEditing: true, message: 'The address is invalid.' }

		assert.equal(mergeAddressWindowErrorState(validationError, undefined), undefined)
	})

	test('shows a non-blocking error when address window state sync fails', async () => {
		const state = new Signal<ModifyAddressWindowState>({
			windowStateId: '1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract',
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User',
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			}
		})

		await updateModifyAddressWindowState(
			state,
			previousState => previousState,
			async () => {
				throw new Error('background unavailable')
			}
		)

		assert.deepEqual(state.value.errorState, {
			blockEditing: false,
			message: 'Failed to update address window state: background unavailable',
		})
	})

	test('renders editable addresses in a wrapping single-value control', () => {
		assert.match(addNewAddressSource, /<textarea[^>]+class = 'input address-editor-address-input'/s)
		assert.match(addNewAddressSource, /rows = \{ 1 \}/)
		assert.match(addNewAddressSource, /replaceAll\('\\n', ''\)\.replaceAll\('\\r', ''\)/)
		assert.doesNotMatch(addNewAddressSource, /What should we call this address/)
		assert.match(addNewAddressSource, /<small>Sites see this address without asking user<\/small>/)
		assert.doesNotMatch(addNewAddressSource, /Reduces protection when this address is active\./)
	})

	test('renders on-chain Gnosis Safe owners as signer choices', () => {
		assert.match(addNewAddressSource, /class = 'address-editor-readonly-address'/)
		assert.ok(addNewAddressSource.indexOf('<span>Name</span>') < addNewAddressSource.indexOf('<span>Address type</span>'))
		assert.ok(addNewAddressSource.indexOf('<span>Address type</span>') < addNewAddressSource.indexOf('<span>Chain</span>'))
		assert.match(addNewAddressSource, /class = 'address-editor-identity-controls'[\s\S]*?<span>Name<\/span>[\s\S]*?<span>Address type<\/span>[\s\S]*?<span>Chain<\/span>/)
		assert.match(addNewAddressSource, /<AddressIcon address = \{ stringToAddress[^\n]+isBig = \{ true \}/)
		assert.match(addNewAddressSource, /ariaLabel = 'Address type'/)
		assert.match(addNewAddressSource, /ariaLabel = 'Chain'/)
		assert.equal((addNewAddressSource.match(/class = 'address-editor-disclosure-chevron'/g) ?? []).length, 2)
		assert.match(addNewAddressSource, /class = 'address-editor-disclosure-chevron' aria-hidden = 'true'><ChevronIcon \/>/)
		assert.match(addNewAddressSource, /class = 'address-editor-heading'>Safe owners/)
		assert.match(addNewAddressSource, /class = 'safe-signer-owner-list' role = 'radiogroup' aria-label = 'Safe signer in simulation'/)
		assert.match(addNewAddressSource, /<p>Safe signer in simulation<\/p>/)
		assert.match(addNewAddressSource, /name = 'safe-simulation-signer'/)
		assert.match(addNewAddressSource, /<SmallAddress addressBookEntry = \{ addressBookEntry \}/)
		assert.match(addNewAddressSource, /safeSimulationSignerAddressBookEntries\.value = safeContractState\.ownerAddressBookEntries/)
		assert.match(addNewAddressSource, /onChange = \{ \(\) => \{ void setSafeSignerAddress\(safeSignerAddress\) \} \}/)
		assert.match(addNewAddressSource, /nonInteractive = \{ true \}/)
		assert.doesNotMatch(addNewAddressSource, /Add Gnosis Safe signer/)
		assert.doesNotMatch(addNewAddressSource, /Choose the owner used when simulating transactions|Enter a deployed Safe address|Choose how Interceptor uses this address/)
		assert.match(addNewAddressSource, /text = 'Refresh owners'/)
		assert.match(addNewAddressSource, /safeSignerRefreshGeneration\.value \+= 1/)
		assert.match(addNewAddressSource, /safeContractState\.owners\.map\(checksummedAddress\)/)
		assert.match(addNewAddressSource, /address\.toLowerCase\(\) === currentSafeSignerAddress\.toLowerCase\(\)/)
	})

	test('shows pending feedback while an address-book modification is saved', () => {
		assert.match(addNewAddressSource, /state = \{ saveEntryState\.value\.state \}/)
		assert.match(addNewAddressSource, /pendingText = \{ param\.modifyAddressWindowState\.value\.incompleteAddressBookEntry\.addingAddress \? 'Creating\.\.\.' : 'Saving\.\.\.' \}/)
		assert.match(addNewAddressSource, /await waitForSaveEntry\(async \(\) => \{[\s\S]*?saveAddressBookEntryAndSwitch/)
		assert.match(addNewAddressSource, /'Modifying and switching\.\.\.'/)
		assert.match(addNewAddressSource, /saveEntryState\.value\.state === 'pending' \|\| !isCurrentSafeLookupComplete\.value \|\| isAddressBookSubmissionDisabled/)
		assert.match(addNewAddressSource, /lastSuccessfulSafeIdentification/)
	})

	test('preserves known Safe owners on lookup failure and clears them when the target changes', () => {
		assert.match(addNewAddressSource, /const setSafeContractStateError = \(message: string\)/)
		assert.match(addNewAddressSource, /if \(!safeContractState\.ok\) \{[\s\S]*?setSafeContractStateError\(safeContractState\.message\)/)
		assert.match(addNewAddressSource, /const setAddress = async[\s\S]*?safeSignerAddresses: \[\],[\s\S]*?safeSimulationSignerAddress: undefined,[\s\S]*?safeVersion: undefined/)
		assert.match(addNewAddressSource, /const setChain = async[\s\S]*?safeSignerAddresses: \[\],[\s\S]*?safeSimulationSignerAddress: undefined,[\s\S]*?safeVersion: undefined/)
		assert.match(safeContractStateSource, /chainId === 'AllChains'[\s\S]*?'Gnosis Safe wallets must use a specific chain to load their signers\.'/)
		assert.match(safeContractStateSource, /\(dependencies\.getRpcEntry \?\? getSafeContractRpcEntry\)\(ethereum, chainId\)/)
		assert.match(safeContractStateSource, /createEthereumClientService\(/)
		assert.doesNotMatch(safeContractStateSource, /new EthereumClientService|new EthereumJSONRpcRequestHandler/)
		assert.match(serviceLifecycleSource, /export function createEthereumClientService[\s\S]*?new EthereumClientService\([\s\S]*?new EthereumJSONRpcRequestHandler\(rpcNetwork\.httpsRpc/)
		assert.doesNotMatch(safeContractStateSource, /Switch Interceptor to chain/)
		assert.match(addNewAddressSource, /requestPopupSafeContractState/)
		assert.doesNotMatch(addNewAddressSource, /includeSafeContractState/)
	})

	test('keeps Safe contract retrieval separate from generic address identification', () => {
		assert.doesNotMatch(metadataUtilsSource, /export async function identifyAddressWithoutNode/)
		assert.doesNotMatch(popupMessageHandlersSource, /safeContractState|includeSafeContractState/)
		assert.match(replyMessagesSource, /method: funtypes\.Literal\('popup_requestSafeContractState'\)/)
		assert.doesNotMatch(replyMessagesSource, /RequestIdentifyAddress[\s\S]{0,500}includeSafeContractState/)
		assert.match(safeContractStateSource, /getUserAddressBookEntriesForChainIdMorePreciseFirst/)
		assert.match(safeContractStateSource, /if \(!safeSnapshot\.ok\) return[\s\S]*?const localEntries = await \(dependencies\.getLocalEntries \?\? getUserAddressBookEntriesForChainIdMorePreciseFirst\)/)
		assert.doesNotMatch(safeContractStateSource, /try \{[\s\S]*?getUserAddressBookEntriesForChainIdMorePreciseFirst/)
		assert.match(screenshotScriptSource, /message\?\.method === 'popup_requestSafeContractState'\) return await new Promise/)
	})

	test('requires current Safe owners in the editor and persists the authoritative snapshot', () => {
		assert.match(addNewAddressSource, /parsedSafeSignerAddresses\.length === 0[\s\S]*?Gnosis Safe owner metadata is unavailable/)
		assert.match(addNewAddressSource, /!isCurrentSafeLookupComplete\.value \? <><\/> : <ErrorText/)
		assert.match(addNewAddressSource, /areAddressIdentificationKeysEqual\(lastSuccessfulSafeIdentification\.value, currentIdentification\)/)
		assert.match(popupMessageHandlersSource, /safeSignerAddresses: \[\.\.\.safeState\.owners\]/)
		assert.match(popupMessageHandlersSource, /validateSafeOwnerIsEoa\(ethereum, entry\.data\.address, safeSimulationSignerAddress\)/)
		assert.doesNotMatch(popupMessageHandlersSource, /Promise\.all\(getSafeSignerAddresses\(entry\.data\)/)
	})
})
