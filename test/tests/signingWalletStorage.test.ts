import { beforeEach, expect, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import type { ContactEntry } from '../../app/ts/types/addressBookTypes.js'
import { SigningWallet, SigningWalletBindings } from '../../app/ts/types/signingWallet.js'
import { browserStorageLocalSet } from '../../app/ts/utils/storageUtils.js'

const stored: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []
Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: {
	storage: { local: {
		remove: async (key: string) => { delete stored[key] },
		get: async (keys: string | readonly string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in stored).map((key) => [key, stored[key]])),
		set: async (items: Record<string, unknown>) => { writes.push(items); Object.assign(stored, items) },
	} },
} })
const { getSigningWalletBindings, getUserAddressBookEntries, saveAddressSigningWallet, updateUserAddressBookEntries } = await import('../../app/ts/background/storageVariables.js')
const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
const address = BigInt(privateKeyToAccount(privateKey).address)
const ledger: SigningWallet = { type: 'ledger', label: 'Main device · Account 1', address, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), false)), derivationPath: 'm/44\'/60\'/0\'/0/0' }
const airgap: SigningWallet = { type: 'airgap', label: 'Vault · Account 1', address, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), true)), derivationPath: ledger.derivationPath, sourceFingerprint: 0x11223344 }

beforeEach(async () => {
	for (const key of Object.keys(stored)) delete stored[key]
	writes.length = 0
	await browserStorageLocalSet({ userAddressBookEntriesV3: [], simulationMode: true, independentActiveSimulationAddress: 1n, activeSigningAddress: 2n, websiteAccess: [] })
	writes.length = 0
})

test('onboarding stores the public binding and address together without changing selections, mode or permissions', async () => {
	const before = { ...stored }
	const saved = await saveAddressSigningWallet(address, ledger, undefined, 'Savings')
	expect(saved?.wallet).toEqual(ledger)
	expect(writes).toHaveLength(1)
	expect(Object.keys(writes[0] ?? {}).sort()).toEqual(['signingWalletBindings', 'userAddressBookEntriesV3'])
	for (const key of ['simulationMode', 'independentActiveSimulationAddress', 'activeSigningAddress', 'websiteAccess']) expect(stored[key]).toEqual(before[key])
	expect(await getSigningWalletBindings()).toEqual([saved])
	expect((await getUserAddressBookEntries())[0]).toMatchObject({ address, name: 'Savings', chainId: 'AllChains', useAsActiveAddress: true })
})

test('linking reuses an existing address and removing a binding retains its entry', async () => {
	const existing = { type: 'contact', address, name: 'Existing', chainId: 1n, entrySource: 'User', askForAddressAccess: false } satisfies ContactEntry
	await updateUserAddressBookEntries(() => [existing])
	const first = await saveAddressSigningWallet(address, ledger, undefined, 'Ignored name')
	const second = await saveAddressSigningWallet(address, airgap, first?.revision)
	expect(second?.revision).not.toBe(first?.revision)
	expect(await getUserAddressBookEntries()).toEqual([existing])
	await saveAddressSigningWallet(address, undefined, second?.revision)
	expect(await getUserAddressBookEntries()).toEqual([existing])
	expect(await getSigningWalletBindings()).toEqual([])
})

test('concurrent wallet changes require the reviewed revision and never silently overwrite another wallet', async () => {
	const results = await Promise.allSettled([saveAddressSigningWallet(address, ledger, undefined, 'Savings'), saveAddressSigningWallet(address, airgap, undefined, 'Savings')])
	expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
	expect((await getSigningWalletBindings())[0]?.wallet.type).toBe('ledger')
	expect(await getUserAddressBookEntries()).toHaveLength(1)
	await expect(saveAddressSigningWallet(address, undefined, undefined)).rejects.toThrow('changed')
})

test('wallet onboarding shares serialization with address book edits', async () => {
	await Promise.all([saveAddressSigningWallet(address, ledger, undefined, 'Savings'), updateUserAddressBookEntries((entries) => [...entries, { type: 'contact', address: 3n, name: 'Manual', entrySource: 'User' }])])
	expect((await getUserAddressBookEntries()).map((entry) => entry.address)).toEqual([address, 3n])
	expect(await getSigningWalletBindings()).toHaveLength(1)
})

test('mismatching public identities, private keys, invalid paths and Safe bindings are rejected before writing', async () => {
	for (const invalid of [{ ...ledger, address: 4n }, { ...ledger, publicKey: privateKey }, { ...ledger, derivationPath: 'm/44\'/60\'/*' }, { ...airgap, sourceFingerprint: 0 }, { ...airgap, derivationPath: 'm/44\'/0\'/0\'/0/0' }]) expect(SigningWallet.safeSerialize(invalid).success).toBe(false)
	await expect(saveAddressSigningWallet(4n, ledger, undefined, 'Mismatch')).rejects.toThrow('match')
	expect(writes).toHaveLength(0)
	await updateUserAddressBookEntries(() => [{ type: 'safe', address, name: 'Safe', chainId: 1n, entrySource: 'User', useAsActiveAddress: true }])
	await expect(saveAddressSigningWallet(address, ledger, undefined)).rejects.toThrow('owner')
	expect(await getSigningWalletBindings()).toEqual([])
})

test('absent bindings stay absent and corrupt persisted bindings fail closed without deleting saved data', async () => {
	expect(await getSigningWalletBindings()).toEqual([])
	stored.signingWalletBindings = [{ wallet: { ...ledger, address: '0x0000000000000000000000000000000000000004' }, revision: crypto.randomUUID() }]
	const before = structuredClone(stored)
	await expect(getSigningWalletBindings()).rejects.toThrow()
	expect(stored).toEqual(before)
	const binding = { wallet: ledger, revision: crypto.randomUUID() }
	expect(SigningWalletBindings.safeSerialize([binding, binding]).success).toBe(false)
})

test('removing the last chain-scoped entry prunes its binding while retaining another scope keeps it', async () => {
	await saveAddressSigningWallet(address, ledger, undefined, 'Savings')
	await updateUserAddressBookEntries((entries) => [...entries, { type: 'contact', address, name: 'Chain entry', chainId: 1n, entrySource: 'User' }])
	await updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.chainId === 1n))
	expect(await getSigningWalletBindings()).toHaveLength(1)
	await updateUserAddressBookEntries(() => [])
	expect(await getSigningWalletBindings()).toEqual([])
	expect(stored.signingWalletBindings).toEqual([])
})

test('converting or adding an address as a Safe removes its ordinary signing binding in the same write', async () => {
	const { addUserAddressBookEntryIfItDoesNotExist } = await import('../../app/ts/background/storageVariables.js')
	await saveAddressSigningWallet(address, ledger, undefined, 'Savings')
	const safe = { type: 'safe', address, name: 'Safe', chainId: 1n, entrySource: 'User', useAsActiveAddress: true } satisfies import('../../app/ts/types/addressBookTypes.js').SafeEntry
	await addUserAddressBookEntryIfItDoesNotExist(safe)
	expect(await getSigningWalletBindings()).toEqual([])
	expect(writes.at(-1)).toHaveProperty('signingWalletBindings', [])
	await updateUserAddressBookEntries((entries) => entries.filter((entry) => entry.type !== 'safe'))
	await saveAddressSigningWallet(address, ledger, undefined)
	await updateUserAddressBookEntries(() => [safe])
	expect(await getSigningWalletBindings()).toEqual([])
})

test('lookups never return orphaned or Safe-address bindings even from stale persisted data', async () => {
	const { getSigningWalletBinding } = await import('../../app/ts/background/storageVariables.js')
	await browserStorageLocalSet({ signingWalletBindings: [{ wallet: ledger, revision: crypto.randomUUID() }] })
	expect(await getSigningWalletBinding(address)).toBeUndefined()
	await browserStorageLocalSet({ userAddressBookEntriesV3: [{ type: 'safe', address, name: 'Safe', chainId: 1n, entrySource: 'User', useAsActiveAddress: true }] })
	expect(await getSigningWalletBinding(address)).toBeUndefined()
	await updateUserAddressBookEntries(() => [{ type: 'contact', address, name: 'Restored contact', entrySource: 'User' }])
	expect(await getSigningWalletBinding(address)).toBeUndefined()
})

test('settings backups round-trip every wallet backend and refresh revisions on restore', async () => {
	const { exportSettingsAndAddressBook, importSettingsAndAddressBook } = await import('../../app/ts/background/settings.js')
	const { ExportedSettings } = await import('../../app/ts/types/exportedSettingsTypes.js')
	const browserWallet: SigningWallet = { type: 'browser', address, label: 'Browser account', signerName: 'MetaMask', providerId: 'io.metamask' }
	for (const wallet of [ledger, airgap, browserWallet]) {
		const previous = (await getSigningWalletBindings())[0]
		const saved = await saveAddressSigningWallet(address, wallet, previous?.revision, 'Savings')
		const exported = await exportSettingsAndAddressBook()
		expect(exported.version).toBe('1.6')
		await importSettingsAndAddressBook(ExportedSettings.parse(ExportedSettings.serialize(exported)))
		const restored = (await getSigningWalletBindings())[0]
		expect(restored?.wallet).toEqual(wallet)
		expect(restored?.revision).not.toBe(saved?.revision)
		expect(await getUserAddressBookEntries()).toHaveLength(1)
	}
})

test('legacy settings imports explicitly clear local bindings and invalid new backups leave storage unchanged', async () => {
	const { exportSettingsAndAddressBook, importSettingsAndAddressBook } = await import('../../app/ts/background/settings.js')
	await saveAddressSigningWallet(address, ledger, undefined, 'Savings')
	const exported = await exportSettingsAndAddressBook()
	if (exported.version !== '1.6') throw new Error('Expected current settings backup version')
	const before = structuredClone(stored)
	await expect(importSettingsAndAddressBook({ ...exported, settings: { ...exported.settings, addressBookEntries: [] } })).rejects.toThrow('ordinary addresses')
	expect(stored).toEqual(before)
	const { signingWalletBindings: _bindings, ...legacySettings } = exported.settings
	await importSettingsAndAddressBook({ ...exported, version: '1.5', settings: legacySettings })
	expect(await getSigningWalletBindings()).toEqual([])
	expect(await getUserAddressBookEntries()).toHaveLength(1)
})
