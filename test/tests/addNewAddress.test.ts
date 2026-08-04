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

	test('renders on-chain Gnosis Safe owners as signer choices', () => {
		assert.match(addNewAddressSource, /class = 'safe-signer-editor-title'><Text text = 'Choose a Gnosis Safe signer'\/>/)
		assert.match(addNewAddressSource, /class = 'safe-signer-editor-row'/)
		assert.match(addNewAddressSource, /type = 'radio'\s+name = 'active-safe-signer'/)
		assert.doesNotMatch(addNewAddressSource, /Add Gnosis Safe signer/)
		assert.match(addNewAddressSource, /safeContractState\.owners\.map\(checksummedAddress\)/)
		assert.match(addNewAddressSource, /address\.toLowerCase\(\) === currentSafeSignerAddress\.toLowerCase\(\)/)
	})

	test('shows pending feedback while an address-book modification is saved', () => {
		assert.match(addNewAddressSource, /state = \{ saveEntryState\.value\.state \}/)
		assert.match(addNewAddressSource, /pendingText = \{ param\.modifyAddressWindowState\.value\.incompleteAddressBookEntry\.addingAddress \? 'Creating\.\.\.' : 'Modifying\.\.\.' \}/)
		assert.match(addNewAddressSource, /await waitForSaveEntry\(async \(\) => \{[\s\S]*?saveAddressBookEntryAndSwitch/)
		assert.match(addNewAddressSource, /'Modifying and switching\.\.\.'/)
		assert.match(addNewAddressSource, /saveEntryState\.value\.state === 'pending' \|\| isAddressBookSubmissionDisabled/)
	})

	test('clears stale Safe owners when refreshing contract state fails', () => {
		assert.match(addNewAddressSource, /const clearSafeContractState = \(message: string\)/)
		assert.match(addNewAddressSource, /safeSignerAddresses: \[\],[\s\S]*?safeSignerAddress: undefined,[\s\S]*?safeVersion: undefined/)
		assert.match(addNewAddressSource, /if \(!safeContractState\.ok\) \{[\s\S]*?clearSafeContractState\(safeContractState\.message\)/)
		assert.match(addNewAddressSource, /requestedIdentification\.chainId === 'AllChains'[\s\S]*?'Gnosis Safe wallets must use a specific chain to load their signers\.'/)
	})
})
