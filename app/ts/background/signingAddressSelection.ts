import type { Settings } from '../types/interceptor-messages.js'
import type { TabState } from '../types/user-interface-types.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { getActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { getSafeSigningEntry } from '../types/addressBookTypes.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getSigningAddressPreferences, rememberSigningAddressPreference } from './settings.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

export async function getConfiguredSigningSafe(settings: Settings) {
	return getSafeSigningEntry(
		await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId),
		{ ...settings, chainId: settings.activeRpcNetwork.chainId },
	)
}

export async function rememberSigningAddressSelection(preference: SigningAddressPreference) {
	await rememberSigningAddressPreference(preference)
}

async function getRememberedSigningSelection(signerAddress: bigint, settings: Settings): Promise<ActiveAddressSelection> {
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
	const selectedSafe = await getConfiguredSigningSafe(settings)
	const configuredActiveAddress = settings.simulationMode ? settings.activeSimulationAddress : previousTabState.activeSigningAddress
	const signerAddress = currentTabState.signerAccounts[0]
	const rememberedSelection = !settings.simulationMode && signerAddress !== undefined
		? await getRememberedSigningSelection(signerAddress, settings)
		: undefined
	const rememberedSelectionIsActive = rememberedSelection?.type === 'signer'
		? settings.useSignersAddressAsActiveAddress && selectedSafe === undefined && configuredActiveAddress === signerAddress
		: rememberedSelection !== undefined && !settings.useSignersAddressAsActiveAddress && selectedSafe?.address === rememberedSelection.entry.address
	const signerAccountChanged = previousTabState.activeSigningAddress !== currentTabState.activeSigningAddress
	const shouldClearDisconnectedSigner = !settings.simulationMode
		&& signerAddress === undefined
		&& (!settings.useSignersAddressAsActiveAddress || selectedSafe !== undefined || configuredActiveAddress !== undefined)
	const shouldRestoreRememberedSelection = rememberedSelection !== undefined
		&& !rememberedSelectionIsActive
		&& (signerAccountChanged || selectedSafe === undefined)
	const shouldUpdateUnrememberedSignerAddress = rememberedSelection === undefined && selectedSafe === undefined && (
		settings.useSignersAddressAsActiveAddress && configuredActiveAddress !== signerAddress
		|| !settings.simulationMode && signerAccountChanged
	)
	const shouldActivate = shouldClearDisconnectedSigner || shouldRestoreRememberedSelection || shouldUpdateUnrememberedSignerAddress
	if (!shouldActivate || shouldClearDisconnectedSigner) return { shouldActivate, selection: undefined, signerAddress }
	if (rememberedSelection !== undefined) return { shouldActivate, selection: rememberedSelection, signerAddress }
	const activeChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)
	return {
		shouldActivate,
		selection: signerAddress === undefined
			? undefined
			: getActiveAddressSelection('signer', activeChainEntries, false, settings.activeRpcNetwork.chainId, [signerAddress]),
		signerAddress,
	}
}
