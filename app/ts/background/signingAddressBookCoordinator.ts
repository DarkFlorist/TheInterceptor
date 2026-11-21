import { getUserAddressBookEntries, userAddressBookEntriesStorageWrite } from './addressBookStore.js'
import { isSigningWalletBindingsStorageWrite, readSigningWalletBindings, signingWalletBindingsStorageWrite } from './signingWalletStore.js'
import { getOrdinarySigningAddresses, reconcileSigningWalletBindings } from '../utils/signingWalletEligibility.js'
import { SigningWallet, SigningWalletBindings } from '../types/signingWallet.js'
import type { AddressBookEntry, AddressBookEntries } from '../types/addressBookTypes.js'
import { assertSigningWalletIdentity } from '../signing/publicAccountIdentity.js'
import { signingOperationError } from '../signing/signingOperationError.js'
import { runSettingsStorageTransaction, type StorageWrite } from './settingsStorageTransaction.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'

// All combined writes enforce address classification here; imports validate strictly before reaching this boundary. The settings storage transaction applies the returned writes in one storage set.
function addressBookAndSigningWalletBindingsWrites(entries: AddressBookEntries, bindings?: SigningWalletBindings, previousBindings?: SigningWalletBindings): readonly StorageWrite[] {
	const addressBookWrite = userAddressBookEntriesStorageWrite(entries)
	if (bindings === undefined) return [addressBookWrite]
	const reconciled = reconcileSigningWalletBindings(entries, bindings)
	const bindingsChanged = previousBindings === undefined || reconciled.length !== previousBindings.length || reconciled.some((binding, index) => binding !== previousBindings[index])
	return bindingsChanged ? [addressBookWrite, signingWalletBindingsStorageWrite(reconciled)] : [addressBookWrite]
}

// Runs a transaction of this coordinator and, once it committed a binding change, tells open extension pages to request the bindings again.
async function runBindingsTransaction<Result>(plan: () => Promise<{ readonly writes: readonly StorageWrite[], readonly result: Result }>) {
	let bindingsWritten = false
	const result = await runSettingsStorageTransaction(async () => {
		const planned = await plan()
		bindingsWritten = planned.writes.some(isSigningWalletBindingsStorageWrite)
		return planned
	})
	if (bindingsWritten) await sendPopupMessageToOpenWindows({ method: 'popup_signingWalletBindingsChanged' })
	return result
}

// The caller must present the revision it reviewed; onboarding uses undefined for an address with no binding. Address selection, mode, and website permissions are deliberately outside this mutation.
export async function saveAddressSigningWallet(address: bigint, wallet: SigningWallet | undefined, expectedRevision: string | undefined, newAddressName?: string) {
	const savedWallet = wallet === undefined ? undefined : Object.freeze({ ...wallet })
	if (savedWallet !== undefined) {
		if (!SigningWallet.safeSerialize(savedWallet).success) throw signingOperationError('Invalid signing wallet public account')
		if (savedWallet.address !== address) throw signingOperationError('Signing wallet does not match this address')
		assertSigningWalletIdentity(savedWallet)
	}
	return await runBindingsTransaction(async () => {
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
		return { writes: addressBookAndSigningWalletBindingsWrites(nextEntries, nextBindings, storedBindings), result: binding }
	})
}

/** Bind Safe owner/execution choices atomically with the saved wallets that make them usable. */
export async function saveSafeSigningAccounts(chainId: bigint, address: bigint, owner: bigint, executor: bigint | undefined, owners: readonly bigint[]) {
	await runSettingsStorageTransaction(async () => {
		const entries = await getUserAddressBookEntries()
		if (!entries.some((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId)) throw signingOperationError('Save this Safe in the address book before changing its signing accounts')
		const bindings = reconcileSigningWalletBindings(entries, await readSigningWalletBindings())
		if (!owners.includes(owner)) throw signingOperationError('The selected signing account is not a current Safe owner')
		if (!bindings.some((binding) => binding.wallet.address === owner)) throw signingOperationError('Set up the owner’s signing wallet first')
		// A gas payer need not be a Safe owner. A public binding is configuration, not proof of authority; the execution pipeline still checks the account and verifies its actual signature.
		if (executor !== undefined && !bindings.some((binding) => binding.wallet.address === executor)) throw signingOperationError('Set up the execution account’s signing wallet first')
		return { writes: [userAddressBookEntriesStorageWrite(entries.map((entry) => entry.type === 'safe' && entry.address === address && entry.chainId === chainId ? { ...entry, safeSigningSignerAddress: owner, safeExecutionAddress: executor, safeSignerAddresses: owners } : entry))], result: undefined }
	})
}

/** The address editor does not manage a Safe's signing accounts, which saveSafeSigningAccounts sets, so an edit of the same Safe keeps them from the stored entry. The signing owner is kept only while it is still one of the Safe's validated owners. An entry that is no longer a Safe has no signing accounts. */
export function keepSafeSigningAccounts(stored: AddressBookEntry | undefined, edited: AddressBookEntry): AddressBookEntry {
	if (stored?.type !== 'safe' || edited.type !== 'safe' || stored.address !== edited.address) return edited
	const owner = edited.safeSigningSignerAddress ?? stored.safeSigningSignerAddress
	const executor = edited.safeExecutionAddress ?? stored.safeExecutionAddress
	return {
		...edited,
		...(owner !== undefined && edited.safeSignerAddresses?.includes(owner) === true ? { safeSigningSignerAddress: owner } : {}),
		...(executor === undefined ? {} : { safeExecutionAddress: executor }),
	}
}

/** Address edits atomically prune invalid signing bindings; unchanged eligibility skips signing-storage access. */
export async function updateAddressBookAndSigningWalletBindings(updateFunc: (prevState: AddressBookEntries) => AddressBookEntries) {
	await runBindingsTransaction(async () => {
		const entries = await getUserAddressBookEntries()
		const nextEntries = updateFunc(entries)
		const previousAddresses = getOrdinarySigningAddresses(entries)
		const nextAddresses = getOrdinarySigningAddresses(nextEntries)
		// Metadata-only edits cannot change binding eligibility, so they need no signing-storage access.
		if (previousAddresses.size === nextAddresses.size && [...previousAddresses].every((address) => nextAddresses.has(address))) {
			return { writes: addressBookAndSigningWalletBindingsWrites(nextEntries), result: undefined }
		}
		const bindings = await readSigningWalletBindings()
		// Check both snapshots so restoring an ordinary address never revives a previously orphaned binding.
		const nextBindings = bindings.filter((binding) => previousAddresses.has(binding.wallet.address) && nextAddresses.has(binding.wallet.address))
		return { writes: addressBookAndSigningWalletBindingsWrites(nextEntries, nextBindings, bindings), result: undefined }
	})
}

// Every write here keeps the stored bindings to eligible addresses, so an eligibility-neutral address-book addition cannot revive one. Startup removes any left by older or externally changed storage.
export async function pruneIneligibleSigningWalletBindings() {
	await runBindingsTransaction(async () => {
		const [entries, bindings] = await Promise.all([getUserAddressBookEntries(), readSigningWalletBindings()])
		const eligible = reconcileSigningWalletBindings(entries, bindings)
		return { writes: eligible.length === bindings.length ? [] : [signingWalletBindingsStorageWrite(eligible)], result: undefined }
	})
}

// A backup restore replaces the bindings with the imported ones; the settings import composes these writes into its single storage transaction, so an invalid backup throws before anything is written.
export function addressBookAndSigningWalletBindingsImportWrites(entries: AddressBookEntries, bindings: SigningWalletBindings): readonly StorageWrite[] {
	if (!SigningWalletBindings.safeSerialize(bindings).success) throw new Error('Invalid imported signing wallet bindings')
	for (const binding of bindings) assertSigningWalletIdentity(binding.wallet)
	if (reconcileSigningWalletBindings(entries, bindings).length !== bindings.length) throw new Error('Imported signing wallets must belong to ordinary addresses in the imported address book')
	// Restoring the same backup is still an explicit wallet change and must invalidate approvals pinned to any earlier revision.
	return addressBookAndSigningWalletBindingsWrites(entries, bindings.map((binding) => ({ wallet: binding.wallet, revision: crypto.randomUUID() })))
}
