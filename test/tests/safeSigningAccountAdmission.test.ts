import { beforeEach, expect, test } from 'bun:test'
import { createBrowserMock, resetConfirmTransactionTestState, createSafeAddressBookEntry, ethereum, simulator, fakeSafeContract, activeAddress } from './confirmTransactionTestHarness.js'
import { SigningPageRequest } from '../../app/ts/types/directSigning.js'
import { getUserAddressBookEntries, saveAddressSigningWallet, updateUserAddressBookEntries, getSigningWalletBinding } from '../../app/ts/background/storageVariables.js'
import { browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'

const { signingPageHandler } = await import('../../app/ts/background/signingPageHandler.js')

const saveWallet = async (address: bigint) => await saveAddressSigningWallet(address, { type: 'browser', address, label: 'Test account', signerName: 'MetaMask', providerId: 'eip6963:io.metamask' }, undefined, 'Test account')
const select = async (executor: bigint | undefined, owner = 1n, chainId = ethereum.getChainId()) => await signingPageHandler(SigningPageRequest.serialize({ method: 'signing_setSafeAccounts', chainId, address: activeAddress, owner, executor }), ethereum, simulator.tokenPriceService, new Map())

beforeEach(async () => {
	createBrowserMock()
	await resetConfirmTransactionTestState()
	await browserStorageLocalSet({ userAddressBookEntriesV3: [], signingWalletBindings: [] })
	await updateUserAddressBookEntries(() => [createSafeAddressBookEntry()])
	fakeSafeContract.owners = [1n]
	fakeSafeContract.threshold = 1n
	await saveWallet(1n)
})

test('Safe account handler rejects an explicit executor without a binding and leaves settings unchanged', async () => {
	const before = await getUserAddressBookEntries()
	expect(await select(2n)).toMatchObject({ ok: false, message: 'Set up the execution account’s signing wallet first' })
	expect(await getUserAddressBookEntries()).toEqual(before)
})

test('Safe account handler permits a saved non-owner gas payer and owner fallback', async () => {
	await saveWallet(2n)
	expect(await select(2n)).toEqual({ ok: true })
	expect((await getUserAddressBookEntries()).find((entry) => entry.type === 'safe')).toMatchObject({ safeSigningSignerAddress: 1n, safeExecutionAddress: 2n })
	expect(await select(undefined)).toEqual({ ok: true })
	const savedSafe = (await getUserAddressBookEntries()).find((entry) => entry.type === 'safe')
	expect(savedSafe?.safeSigningSignerAddress).toBe(1n)
	expect(savedSafe?.safeExecutionAddress).toBeUndefined()
})

test('Safe account handler retains on-chain owner and saved-owner checks', async () => {
	await saveWallet(2n)
	expect(await select(undefined, 2n)).toMatchObject({ ok: false, message: 'The selected signing account is not a current Safe owner' })
	fakeSafeContract.owners = [3n]
	expect(await select(undefined, 3n)).toMatchObject({ ok: false, message: 'Set up the owner’s signing wallet first' })
	expect(await select(undefined, 1n, 999n)).toMatchObject({ ok: false, message: 'Return to this Safe’s network before changing its signing accounts' })
})

test('Safe account handler rejects a binding removed while the Safe state is loading', async () => {
	await saveWallet(2n)
	fakeSafeContract.beforeVersionResponse = async () => {
		const binding = await getSigningWalletBinding(2n)
		await saveAddressSigningWallet(2n, undefined, binding?.revision)
	}
	expect(await select(2n)).toMatchObject({ ok: false, message: 'Set up the execution account’s signing wallet first' })
})
