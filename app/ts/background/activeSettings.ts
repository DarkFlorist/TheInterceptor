import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { reconcileCommittedAccessChangeCollectingFailures, reconcileWebsiteApprovalAccessesCollectingFailures, finishWebsiteAccessUpdate, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { reconcileAfterIndependentSteps } from './committedWriteReconciliation.js'
import { runEachIndependently } from './terminalStateRecovery.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeSimulationMode, getSettingsAfterStorageUpdates, getSettingsSnapshot, getAdmittedRpcNetworkSnapshot, setUseSignersAddressAsActiveAddress, type SimulationModeChanges, trackPreviousActiveAddressForMakeMeRichList, requireAvailableSettings, settingsForPublication, settingsWithoutApprovals, captureRpcNetwork, settingsIfAvailable } from './settings.js'
import { updateTransactionState } from './storageVariables.js'
import type { RpcConfigurationState } from './rpcConfigurationStorage.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { LocalStorageItems } from '../utils/storageUtils.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext } from '../utils/activeStackContext.js'
import { rpcConfigurationIsReady, rpcConfigurationIsUsable, rpcServicesAreOptional } from './rpcConfigurationAvailability.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'

async function clearSimulationStateFromConfig(settingsSnapshot?: Settings) {
	const settings = settingsSnapshot ?? requireAvailableSettings(await getSettingsSnapshot())
	const activeStackContext = getActiveStackContext(settings)
	await updateTransactionState((previousState) => {
		if (settings.simulationMode) {
			return {
				interceptorTransactionStack: {
					operations: previousState.interceptorTransactionStack.operations.filter((operation) =>
						!operationBelongsToActiveStackContext(operation, activeStackContext)
					),
				},
				safeTransactionStacks: previousState.safeTransactionStacks,
			}
		}
		const activeSafeAddress = settings.activeSigningSafeAddress
		const activeChainId = settings.activeRpcNetwork.chainId
		return {
			interceptorTransactionStack: {
				operations: previousState.interceptorTransactionStack.operations.filter((operation) =>
					!operationBelongsToActiveStackContext(operation, activeStackContext)
				),
			},
			safeTransactionStacks: previousState.safeTransactionStacks.filter((stack) =>
				stack.safeAddress !== activeSafeAddress || stack.chainId !== activeChainId
			),
		}
	})
}

export async function resetSimulationStateFromConfig(simulationServicesOwner: SimulationServicesOwner) {
	await clearSimulationStateFromConfig()
	await queuePopupSimulationRefresh({ ...simulationServicesOwner.requireCurrent(), invalidateOldState: true })
}

const keepTrackOfPreviousAddressForRichList = async (previousSettings: Settings) => await trackPreviousActiveAddressForMakeMeRichList(previousSettings.activeSimulationAddress)

type ActiveAddressAndChainChange = {
	simulationMode: boolean
	activeAddress?: bigint
	signingAddressSelection?: 'signer' | 'safe'
	rpcNetwork?: RpcNetwork
	promptForAccessesIfNeeded?: boolean
}

type ActiveSettingsTransition = {
	readonly change: ActiveAddressAndChainChange
	readonly simulationSignerSelection?: { readonly useSignerAddress: boolean, readonly signerAddress: bigint | undefined }
	readonly signingPreference?: SigningAddressPreference
	readonly admittedSnapshot?: { readonly settings: Settings, readonly rpcConfiguration: RpcConfigurationState }
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)

// Publishes a committed settings transition and reconciles website access with it. It never throws: the failures are returned in the order they occurred for the committing operation's single collector to surface. A failure before the reconciliation (clearing simulation state, publishing the settings) still lets the reconciliation run, but skips the notifications after it.
async function publishCommittedSettingsTransition(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	previousSettings: Settings,
	updatedSettings: Settings,
	onAccessReconciled: (accessUpdate: WebsiteAccessUpdate) => void,
	forceChainChanged = false,
): Promise<readonly unknown[]> {
	const networkChange = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	const rpcChainChanged = forceChainChanged || networkChange.chainChanged
	const rpcEndpointChanged = forceChainChanged || networkChange.endpointChanged
	const publicationFailures = await runEachIndependently([
		async () => { if (updatedSettings.simulationMode && rpcChainChanged) await clearSimulationStateFromConfig(updatedSettings) },
		async () => await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration() }),
	], async (step) => await step())
	const reconciliation = await reconcileWebsiteApprovalAccessesCollectingFailures(websiteTabConnections, updatedSettings)
	onAccessReconciled(reconciliation.update)
	if (publicationFailures.length > 0) return [...publicationFailures, ...reconciliation.failures]
	try {
		await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
		if (rpcChainChanged) {
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
			await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
		}
		if (simulationServicesOwner.getCurrent() !== undefined && (updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (rpcEndpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))) {
			await queuePopupSimulationRefresh({ ...simulationServicesOwner.requireCurrent(), settingsSnapshot: updatedSettings })
		}
		await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, updatedSettings)
	} catch (notificationFailure: unknown) {
		return [...reconciliation.failures, notificationFailure]
	}
	return reconciliation.failures
}

function getSimulationModeChanges(change: ActiveAddressAndChainChange): SimulationModeChanges {
	if (change.simulationMode) {
		return {
			simulationMode: change.simulationMode,
			...('activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}),
			...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
		}
	}
	if ('activeAddress' in change && change.signingAddressSelection === undefined) throw new Error('Signing address changes must identify whether the selection is the signer or a Safe.')
	const selectsSafe = change.signingAddressSelection === 'safe'
	return {
		simulationMode: change.simulationMode,
		...(!selectsSafe && 'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
		...('activeAddress' in change ? { activeSigningSafeAddress: selectsSafe ? change.activeAddress : undefined } : {}),
		...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
	}
}

// The recovery step of a committed RPC configuration write. It never throws: its failures are returned, in order, for the write's single collector (see completeRpcListTransition) to surface.
export async function publishRpcConfigurationRecovery(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	previousSettings: Settings | undefined,
	activeRpcNetwork: RpcNetwork,
	forceChainChanged = false,
): Promise<readonly unknown[]> {
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		// Read and published in the same lock as active-settings transitions, so a transition committed meanwhile is never overwritten by these older settings. The RPC configuration write is committed, so it is reconciled like any committed access change: when its settings cannot be read back, every runtime approval fails closed.
		return await changeActiveAddressAndChainSemaphore.execute(async () => await reconcileCommittedAccessChangeCollectingFailures(websiteTabConnections, { kind: 'rpc-configuration' }, async (updatedSettings) => {
			if (getRpcNetworkChange(updatedSettings.activeRpcNetwork, activeRpcNetwork).selectionChanged) throw new Error('Recovered RPC network does not match the committed configuration.')
			return await publishCommittedSettingsTransition(
				simulationServicesOwner,
				websiteTabConnections,
				previousSettings ?? updatedSettings,
				updatedSettings,
				(update) => { accessUpdate = update },
				forceChainChanged,
			)
		}))
	} finally {
		if (accessUpdate !== undefined) await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, accessUpdate, true)
	}
}

async function runActiveSettingsChange(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	transition: ActiveSettingsTransition,
): Promise<void> {
	const { change } = transition
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		// Settings, approvals, resets, notifications and selection preferences form one ordered transition.
		await changeActiveAddressAndChainSemaphore.execute(async () => {
			// The baseline is the settings committed when the semaphore is acquired, so a network change made after admission is never overwritten; the admitted settings stand in only when the live settings cannot be read.
			const liveSnapshot = await getSettingsSnapshot()
			const previousSettings = settingsIfAvailable(liveSnapshot) ?? transition.admittedSnapshot?.settings ?? requireAvailableSettings(liveSnapshot)
			// Authorization is separate from the baseline: an admitted transition may still complete after the RPC configuration became unreadable since admission, so the admitted configuration authorizes it when the live one is not ready.
			const authorizingRpcConfiguration = transition.admittedSnapshot === undefined || rpcConfigurationIsReady(liveSnapshot.rpcConfiguration) ? liveSnapshot.rpcConfiguration : transition.admittedSnapshot.rpcConfiguration
			const rpcServicesOptional = rpcServicesAreOptional(authorizingRpcConfiguration)
			const recoverServicesOnRpcSelection = simulationServicesOwner.getCurrent() === undefined && rpcServicesOptional
			if (!rpcConfigurationIsUsable(authorizingRpcConfiguration, simulationServicesOwner)) throw createRpcConfigurationUnavailableError()
			const committedStorageUpdates: LocalStorageItems[] = []
			if (transition.simulationSignerSelection !== undefined) {
				const { useSignerAddress, signerAddress } = transition.simulationSignerSelection
				committedStorageUpdates.push(await setUseSignersAddressAsActiveAddress(useSignerAddress, signerAddress))
			}
			if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressForRichList(previousSettings)
			committedStorageUpdates.push(await changeSimulationMode(getSimulationModeChanges(change)))

			// Derived from the exact items just written; it pins the committed RPC network.
			const committedSettings = await getSettingsAfterStorageUpdates(previousSettings, committedStorageUpdates)
			// Published without website approvals (which may have been revoked since admission) unless the read-back below succeeds.
			let updatedSettings = settingsWithoutApprovals(committedSettings)
			// Set before provider installation and cleared once it succeeds, so the step after it knows whether a failed installation invalidated simulation output.
			let providerInstallationFailed = false
			// The writes above are committed, so neither the read-back nor provider preparation may skip publishing and reconciling them; their failures are surfaced afterwards.
			await reconcileAfterIndependentSteps([
				async () => { updatedSettings = settingsForPublication(await getAdmittedRpcNetworkSnapshot(captureRpcNetwork(committedSettings)), committedSettings) },
				async () => {
					// The preference belongs to the committed selection, even if later provider preparation fails.
					if (transition.signingPreference !== undefined) await rememberSigningAddressSelection(transition.signingPreference)
					const { endpointChanged: rpcEndpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, committedSettings.activeRpcNetwork)
					// A signer-only chain has no provider to install; simulation is disabled until a configured endpoint is selected.
					if (!rpcEndpointChanged || change.rpcNetwork?.httpsRpc === undefined) return
					providerInstallationFailed = true
					if (simulationServicesOwner.getCurrent() !== undefined) simulationServicesOwner.reset(change.rpcNetwork)
					else if (recoverServicesOnRpcSelection) simulationServicesOwner.recover(change.rpcNetwork)
					else throw createRpcConfigurationUnavailableError()
					providerInstallationFailed = false
				},
				// Only failed provider installation invalidates simulation output. Published as its own step, so its failure is collected after the installation's instead of replacing it.
				async () => { if (providerInstallationFailed) await publishFailedPopupVisualisation() },
			], async () => await publishCommittedSettingsTransition(simulationServicesOwner, websiteTabConnections, previousSettings, updatedSettings, (update) => { accessUpdate = update }))
		})
	} finally {
		// Complete committed access updates after releasing the semaphore, even if a later reset or notification fails.
		if (accessUpdate !== undefined) {
			await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, accessUpdate, change.promptForAccessesIfNeeded ?? true)
		}
	}
}

export async function changeActiveAddressAndChain(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	change: ActiveAddressAndChainChange,
	admittedSnapshot?: { readonly settings: Settings, readonly rpcConfiguration: RpcConfigurationState },
): Promise<void> {
	return await runActiveSettingsChange(simulationServicesOwner, websiteTabConnections, { change, ...(admittedSnapshot === undefined ? {} : { admittedSnapshot }) })
}

export async function activateAddressSelection(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	selection: ActiveAddressSelection | undefined,
	options: {
		readonly simulationMode: boolean
		readonly signerAddress: bigint | undefined
		readonly rpcNetwork?: RpcNetwork
		readonly promptForAccessesIfNeeded?: boolean
	},
	admittedSnapshot?: { readonly settings: Settings, readonly rpcConfiguration: RpcConfigurationState },
): Promise<void> {
	const selectedSafe = selection?.type === 'addressBookEntry' && selection.entry.type === 'safe' ? selection.entry : undefined
	if (!options.simulationMode && selection?.type === 'addressBookEntry' && selectedSafe === undefined) throw new Error('Signing mode can only activate the external signer or an owned Gnosis Safe.')
	const useSignerAddress = selection?.type === 'signer' || (!options.simulationMode && selection === undefined)
	const signingPreference: SigningAddressPreference | undefined = options.simulationMode || options.signerAddress === undefined || selection === undefined
		? undefined
		: selectedSafe === undefined
			? { signerAddress: options.signerAddress, selection: 'signer' }
			: { signerAddress: options.signerAddress, selection: 'safe', safeAddress: selectedSafe.address, chainId: selectedSafe.chainId }
	return await runActiveSettingsChange(simulationServicesOwner, websiteTabConnections, {
		change: {
			simulationMode: options.simulationMode,
			activeAddress: selection?.type === 'signer' ? selection.address : selection?.entry.address,
			...(!options.simulationMode ? { signingAddressSelection: selectedSafe === undefined ? 'signer' as const : 'safe' as const } : {}),
			...(options.rpcNetwork === undefined ? {} : { rpcNetwork: options.rpcNetwork }),
			...(options.promptForAccessesIfNeeded === undefined ? {} : { promptForAccessesIfNeeded: options.promptForAccessesIfNeeded }),
		},
		...(options.simulationMode ? { simulationSignerSelection: {
			useSignerAddress,
			signerAddress: useSignerAddress ? selection?.type === 'signer' ? selection.address : options.signerAddress : undefined,
		} } : {}),
		...(signingPreference === undefined ? {} : { signingPreference }),
		...(admittedSnapshot === undefined ? {} : { admittedSnapshot }),
	})
}
