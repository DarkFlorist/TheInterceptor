import { withAddressBookStore, getUserAddressBookEntries } from './addressBookStore.js'
import { readSigningWalletBindings, withSigningWalletStore } from '../signing/signingWalletStore.js'
import { SigningWallet, SigningWalletBindings, type SigningWalletBinding } from '../types/signingWallet.js'
import { doAddressBookChainIdsMatch, type AddressBookEntry, type AddressBookEntries } from '../types/addressBookTypes.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { assertSigningWalletIdentity } from '../signing/publicAccountIdentity.js'
import { signingOperationError } from '../signing/signingOperationError.js'

/** Onboarding, eligibility edits and backup restore require a coherent pair of otherwise independent repositories. */
async function withAddressBookAndSigningWalletStores<T>(operation: () => Promise<T>): Promise<T> {
	return await withAddressBookStore(async () => await withSigningWalletStore(operation))
}

// A binding is global to an ordinary address, retained while any chain-scoped entry remains. A Safe entry in any scope excludes the address from ordinary-account signing.
function getOrdinarySigningAddresses(entries: AddressBookEntries) {
	const ordinaryAddresses = new Set(entries.filter((entry) => entry.type !== 'safe').map((entry) => entry.address))
	const safeAddresses = new Set(entries.filter((entry) => entry.type === 'safe').map((entry) => entry.address))
	return new Set([...ordinaryAddresses].filter((address) => !safeAddresses.has(address)))
}

function reconcileSigningWalletBindings(entries: AddressBookEntries, bindings: SigningWalletBindings) {
	const eligibleAddresses = getOrdinarySigningAddresses(entries)
	return bindings.filter((binding) => eligibleAddresses.has(binding.wallet.address))
}

// All combined writes enforce address classification here; imports validate strictly before reaching this boundary.
async function persistAddressBookAndSigningWalletBindings(entries: AddressBookEntries, bindings?: SigningWalletBindings, previousBindings?: SigningWalletBindings) {
	const reconciled = bindings === undefined ? undefined : reconcileSigningWalletBindings(entries, bindings)
	const bindingsChanged = reconciled !== undefined && (previousBindings === undefined || reconciled.length !== previousBindings.length || reconciled.some((binding, index) => binding !== previousBindings[index]))
	await browserStorageLocalSet({ userAddressBookEntriesV3: entries, ...(bindingsChanged ? { signingWalletBindings: reconciled } : {}) })
}

export async function getAddressBookAndSigningWalletBindings() {
	return await withAddressBookAndSigningWalletStores(async () => {
		const [entries, bindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		return { addressBookEntries: entries, signingWalletBindings: reconcileSigningWalletBindings(entries, bindings) }
	})
}

export async function getSigningWalletBindings(): Promise<SigningWalletBindings> {
	return (await getAddressBookAndSigningWalletBindings()).signingWalletBindings
}

export async function getSigningWalletBinding(address: bigint): Promise<SigningWalletBinding | undefined> {
	return (await getSigningWalletBindings()).find((binding) => binding.wallet.address === address)
}

// The caller must present the revision it reviewed; onboarding uses undefined for an address with no binding. Address selection, mode, and website permissions are deliberately outside this mutation.
export async function saveAddressSigningWallet(address: bigint, wallet: SigningWallet | undefined, expectedRevision: string | undefined, newAddressName?: string) {
	const savedWallet = wallet === undefined ? undefined : Object.freeze({ ...wallet })
	if (savedWallet !== undefined) {
		if (!SigningWallet.safeSerialize(savedWallet).success) throw signingOperationError('Invalid signing wallet public account')
		if (savedWallet.address !== address) throw signingOperationError('Signing wallet does not match this address')
		assertSigningWalletIdentity(savedWallet)
	}
	return await withAddressBookAndSigningWalletStores(async () => {
		const [entries, storedBindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		const bindings = reconcileSigningWalletBindings(entries, storedBindings)
		const previous = bindings.find((binding) => binding.wallet.address === address)
		if (previous?.revision !== expectedRevision) throw signingOperationError('Signing wallet changed. Review the current wallet before saving again.')
		const existing = entries.find((entry) => entry.address === address)
		if (entries.some((entry) => entry.address === address && entry.type === 'safe')) throw signingOperationError('Assign a signing wallet to the Safe owner address, not the Safe.')
		if (existing === undefined && (newAddressName === undefined || newAddressName.trim().length === 0 || newAddressName.length > 100)) throw signingOperationError('Name the new address before saving its signing wallet')
		const binding = savedWallet === undefined ? undefined : { wallet: savedWallet, revision: crypto.randomUUID() }
		const nextBindings = [...bindings.filter((entry) => entry.wallet.address !== address), ...(binding === undefined ? [] : [binding])]
		if (!SigningWalletBindings.safeSerialize(nextBindings).success) throw signingOperationError('Too many or invalid signing wallet bindings')
		const nextEntries: AddressBookEntries = existing !== undefined ? entries : [...entries, { type: 'contact', address, name: newAddressName?.trim() ?? '', entrySource: 'User', useAsActiveAddress: true, chainId: 'AllChains' }]
		await persistAddressBookAndSigningWalletBindings(nextEntries, nextBindings, storedBindings)
		return binding
	})
}

/** Bind Safe owner/execution choices atomically with the saved wallets that make them usable. */
export async function saveSafeSigningAccounts(chainId: bigint, address: bigint, owner: bigint, executor: bigint | undefined, owners: readonly bigint[]) {
	await withAddressBookAndSigningWalletStores(async () => {
		const entries = await getUserAddressBookEntries()
		if (!entries.some((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId)) throw signingOperationError('Save this Safe in the address book before changing its signing accounts')
		const bindings = reconcileSigningWalletBindings(entries, await readSigningWalletBindings())
		if (!owners.includes(owner)) throw signingOperationError('The selected signing account is not a current Safe owner')
		if (!bindings.some((binding) => binding.wallet.address === owner)) throw signingOperationError('Set up the owner’s signing wallet first')
		// A gas payer need not be a Safe owner. A public binding is configuration, not proof of authority; the execution pipeline still checks the account and verifies its actual signature.
		if (executor !== undefined && !bindings.some((binding) => binding.wallet.address === executor)) throw signingOperationError('Set up the execution account’s signing wallet first')
		await browserStorageLocalSet({ userAddressBookEntriesV3: entries.map((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId ? { ...entry, safeSigningSignerAddress: owner, safeExecutionAddress: executor, safeSignerAddresses: owners } : entry) })
	})
}

/** Address edits atomically prune invalid signing bindings; unchanged eligibility skips signing-storage access. */
export async function updateAddressBookAndSigningWalletBindings(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await withAddressBookAndSigningWalletStores(async () => {
		const entries = await getUserAddressBookEntries()
		const nextEntries = updateFunc(entries)
		const previousAddresses = getOrdinarySigningAddresses(entries)
		const nextAddresses = getOrdinarySigningAddresses(nextEntries)
		// Metadata-only edits cannot change binding eligibility, so they need no signing-storage access.
		if (previousAddresses.size === nextAddresses.size && [...previousAddresses].every((address) => nextAddresses.has(address))) {
			return await persistAddressBookAndSigningWalletBindings(nextEntries)
		}
		const bindings = await readSigningWalletBindings()
		// Check both snapshots so restoring an ordinary address never revives a previously orphaned binding.
		const nextBindings = bindings.filter((binding) => previousAddresses.has(binding.wallet.address) && nextAddresses.has(binding.wallet.address))
		return await persistAddressBookAndSigningWalletBindings(nextEntries, nextBindings, bindings)
	})
}

export async function replaceAddressBookAndSigningWalletBindings(entriesOrUpdate: AddressBookEntries | ((previous: AddressBookEntries) => AddressBookEntries), bindings: SigningWalletBindings) {
	if (!SigningWalletBindings.safeSerialize(bindings).success) throw new Error('Invalid imported signing wallet bindings')
	for (const binding of bindings) assertSigningWalletIdentity(binding.wallet)
	await withAddressBookAndSigningWalletStores(async () => {
		const entries = typeof entriesOrUpdate === 'function' ? entriesOrUpdate(await getUserAddressBookEntries()) : entriesOrUpdate
		if (reconcileSigningWalletBindings(entries, bindings).length !== bindings.length) throw new Error('Imported signing wallets must belong to ordinary addresses in the imported address book')
		// Restoring the same backup is still an explicit wallet change and must invalidate approvals pinned to any earlier revision.
		await persistAddressBookAndSigningWalletBindings(entries, bindings.map((binding) => ({ wallet: binding.wallet, revision: crypto.randomUUID() })))
	})
}

export async function addUserAddressBookEntryIfItDoesNotExist(newEntry: AddressBookEntry) {
	await updateAddressBookAndSigningWalletBindings((entries) => {
		const existingEntry = entries.find((entry) => entry.address === newEntry.address && doAddressBookChainIdsMatch(entry.chainId, newEntry.chainId))
		return existingEntry !== undefined ? entries : entries.concat(newEntry)
	})
}

