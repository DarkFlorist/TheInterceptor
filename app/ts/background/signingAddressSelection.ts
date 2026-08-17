import type { Settings } from '../types/interceptor-messages.js'
import type { TabState } from '../types/user-interface-types.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { getActiveAddressSelection, resolveSigningSafe } from '../utils/activeAddressSelection.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { getSigningAddressPreferences, rememberSigningAddressPreference } from './settings.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

export function resolveConfiguredSigningSafe(activeSigningSafeAddress: bigint | undefined, chainId: bigint, signerAccounts: readonly bigint[], activeChainEntries: AddressBookEntries) {
	return resolveSigningSafe(activeSigningSafeAddress, chainId, signerAccounts, activeChainEntries)
}

export async function getConfiguredSigningSafeForChain(activeSigningSafeAddress: bigint | undefined, chainId: bigint, signerAccounts: readonly bigint[]) {
	return resolveConfiguredSigningSafe(activeSigningSafeAddress, chainId, signerAccounts, await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId))
}

export async function getConfiguredSigningSafe(settings: Settings, signerAccounts: readonly bigint[]) {
	if (settings.simulationMode) return undefined
	return await getConfiguredSigningSafeForChain(settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId, signerAccounts)
}

export async function rememberSigningAddressSelection(preference: SigningAddressPreference) {
	await rememberSigningAddressPreference(preference)
}

async function getWalletAccountSigningSelection(signerAddress: bigint, settings: Settings): Promise<ActiveAddressSelection> {
	const preference = (await getSigningAddressPreferences()).find((candidate) => candidate.signerAddress === signerAddress)
	const activeChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)
	const signerSelection = getActiveAddressSelection('signer', activeChainEntries, false, settings.activeRpcNetwork.chainId, [signerAddress])
	if (signerSelection === undefined) throw new Error('The connected signing wallet does not expose an active account.')
	if (preference === undefined || preference.selection === 'signer') return signerSelection
	if (preference.chainId !== settings.activeRpcNetwork.chainId) return signerSelection
	const selection = getActiveAddressSelection(preference.safeAddress, activeChainEntries, false, settings.activeRpcNetwork.chainId, [signerAddress])
	return selection?.type === 'addressBookEntry' && selection.entry.type === 'safe' ? selection : signerSelection
}

export type SigningAddressSelectionTransition = {
	readonly shouldActivate: boolean
	readonly selection: ActiveAddressSelection | undefined
	readonly signerAddress: bigint | undefined
}

export async function getSigningAddressSelectionTransition(
	settings: Settings,
	previousTabState: TabState,
	currentTabState: TabState,
): Promise<SigningAddressSelectionTransition> {
	const selectedSafe = await getConfiguredSigningSafe(settings, currentTabState.signerAccounts)
	const configuredActiveAddress = settings.simulationMode
		? settings.activeSimulationAddress
		: selectedSafe?.address ?? previousTabState.activeSigningAddress
	const signerAddress = currentTabState.signerAccounts[0]
	const walletAccountSelection = !settings.simulationMode && signerAddress !== undefined
		? await getWalletAccountSigningSelection(signerAddress, settings)
		: undefined
	const walletAccountSelectionIsActive = walletAccountSelection?.type === 'signer'
		? selectedSafe === undefined && configuredActiveAddress === signerAddress
		: walletAccountSelection !== undefined && selectedSafe?.address === walletAccountSelection.entry.address
	const signerAccountChanged = previousTabState.activeSigningAddress !== currentTabState.activeSigningAddress
	const shouldClearDisconnectedSigner = !settings.simulationMode
		&& signerAddress === undefined
		&& (selectedSafe !== undefined || configuredActiveAddress !== undefined)
	const shouldActivateWalletAccountSelection = walletAccountSelection !== undefined
		&& !walletAccountSelectionIsActive
		&& (signerAccountChanged || selectedSafe === undefined)
	const shouldUpdateSimulationSignerAddress = settings.simulationMode
		&& selectedSafe === undefined
		&& settings.useSignersAddressAsActiveAddress
		&& configuredActiveAddress !== signerAddress
	const shouldActivate = shouldClearDisconnectedSigner || shouldActivateWalletAccountSelection || shouldUpdateSimulationSignerAddress
	if (!shouldActivate || shouldClearDisconnectedSigner) return { shouldActivate, selection: undefined, signerAddress }
	if (walletAccountSelection !== undefined) return { shouldActivate, selection: walletAccountSelection, signerAddress }
	const activeChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)
	return {
		shouldActivate,
		selection: signerAddress === undefined
			? undefined
			: getActiveAddressSelection('signer', activeChainEntries, false, settings.activeRpcNetwork.chainId, [signerAddress]),
		signerAddress,
	}
}
