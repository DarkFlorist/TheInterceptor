import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import { reportUnexpectedError } from '../utils/errors.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeSimulationMode, getSettings, importSettingsAndAddressBook, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { getPrimaryRpcForChain, updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'
import { buildSimulationSnapshot, captureSimulationSnapshot, type NetworkState, readSimulationInputSources } from './simulationUpdating.js'
import { assertNever } from '../utils/typescript.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext, SIMULATION_STACK_CONTEXT } from '../utils/activeStackContext.js'

async function clearSimulationStateFromConfig() {
	const settings = await getSettings()
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

async function clearSimulationStackContext() {
	await updateTransactionState((previousState) => ({
		interceptorTransactionStack: {
			operations: previousState.interceptorTransactionStack.operations.filter((operation) => !operationBelongsToActiveStackContext(operation, SIMULATION_STACK_CONTEXT)),
		},
		safeTransactionStacks: previousState.safeTransactionStacks,
	}))
}

export async function resetSimulationStateFromConfig(simulationServicesOwner: SimulationServicesOwner) {
	await clearSimulationStateFromConfig()
	await queuePopupSimulationRefresh({ ...simulationServicesOwner.getCurrent(), invalidateOldState: true })
}

const keepTrackOfPreviousAddressForRichList = async () => {
	const previousActiveAddress = (await getSettings()).activeSimulationAddress
	await trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress)
}

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
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)

type NetworkChangeEffect = 'installServices' | 'clearStackForChangedChain' | 'notifyWebsitesOfChainChange' | 'notifyPopupsOfChainChange'
const NETWORK_CHANGE_EFFECTS = ['installServices', 'clearStackForChangedChain', 'notifyWebsitesOfChainChange', 'notifyPopupsOfChainChange'] as const

type CommittedNetworkChange = {
	readonly simulationServicesOwner: SimulationServicesOwner
	readonly websiteTabConnections: WebsiteTabConnections
	readonly settingsBeforeTransition: Settings
	readonly completedEffects: Set<NetworkChangeEffect>
}

// Effects that a failed transition could not complete. They live in memory only, so after a background restart services are rebuilt from the settings and websites receive the chain when they reconnect, but a stack left from the previous chain is not cleared.
let unfinishedNetworkChange: CommittedNetworkChange | undefined

// Every effect is idempotent or recorded once it succeeds: installation compares with the installed client, clearing the active stack context twice is harmless, and websites are notified once per committed change. Popup notifications are best-effort.
async function runNetworkChangeEffect(change: CommittedNetworkChange, effect: NetworkChangeEffect, updatedSettings: Settings) {
	if (change.completedEffects.has(effect)) return
	const chainChanged = getRpcNetworkChange(change.settingsBeforeTransition.activeRpcNetwork, updatedSettings.activeRpcNetwork).chainChanged
	switch (effect) {
		case 'installServices': {
			await installServicesForCommittedNetwork(change.simulationServicesOwner, updatedSettings.activeRpcNetwork)
			break
		}
		case 'clearStackForChangedChain': {
			// Simulation stack contexts carry no chain, so their operations are dropped whenever the active chain changes, in either mode; Gnosis Safe stacks are kept per chain.
			if (chainChanged) await clearSimulationStackContext()
			break
		}
		case 'notifyWebsitesOfChainChange': {
			if (chainChanged) sendMessageToApprovedWebsitePorts(change.websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
			break
		}
		case 'notifyPopupsOfChainChange': {
			// Popup delivery is best-effort throughout the background and popups also refresh on the settings broadcast, so a failed delivery is reported but cannot block requests.
			if (chainChanged) await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
			break
		}
		default: assertNever(effect)
	}
	change.completedEffects.add(effect)
}

// Retries the unfinished effects in commit order against the committed settings, so websites hear of the chain only once its state is complete. While one still fails, the rest stay recorded and this throws, so no lock holder proceeds on a network whose effects are incomplete.
async function completeUnfinishedNetworkChange() {
	const change = unfinishedNetworkChange
	if (change === undefined) return
	const committedSettings = await getSettings()
	for (const effect of NETWORK_CHANGE_EFFECTS) await runNetworkChangeEffect(change, effect, committedSettings)
	unfinishedNetworkChange = undefined
}

// Every writer of the active network or of the installed services runs inside this lock, after the effects of an earlier failed transition are completed. It is not reentrant, so the task must not start another transition or read a network snapshot.
export async function runNetworkTransition<T>(task: () => Promise<T>): Promise<T> {
	return await changeActiveAddressAndChainSemaphore.execute(async () => {
		await completeUnfinishedNetworkChange()
		return await task()
	})
}

async function captureNetworkState(): Promise<NetworkState> {
	const settings = await getSettings()
	return { settings, simulation: await captureSimulationSnapshot(settings) }
}

// Reading these under the transition lock keeps a request from pairing one network's settings, stack or services with another network's; it reads storage only, so RPC work stays outside the lock.
export async function readNetworkSnapshot(simulationServicesOwner: SimulationServicesOwner) {
	return await runNetworkTransition(async () => ({ ...await captureNetworkState(), services: simulationServicesOwner.getCurrent() }))
}

// The settings and stack as they are now, for work that changed the stack after its snapshot was read.
export async function readNetworkState() {
	return await runNetworkTransition(captureNetworkState)
}

const isSameStackOperation = (stacked: InterceptorStackOperation, operation: InterceptorStackOperation) => {
	if (stacked.type === 'Transaction' && operation.type === 'Transaction') return stacked.preSimulationTransaction.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
	if (stacked.type === 'Message' && operation.type === 'Message') return stacked.signedMessageTransaction.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
	return false
}

// A confirmed simulation operation joins the stack only while the chain it was simulated on is still active in simulation mode. Returns the stacked operation with the settings, stack snapshot and services read under the same lock, or undefined if that network went away.
export async function appendToActiveSimulationStack(simulationServicesOwner: SimulationServicesOwner, operation: InterceptorStackOperation, simulatedChainId: bigint | undefined) {
	return await runNetworkTransition(async () => {
		const settings = await getSettings()
		if (!settings.simulationMode) return undefined
		if (simulatedChainId !== undefined && simulatedChainId !== settings.activeRpcNetwork.chainId) return undefined
		// Everything the resulting snapshot needs is read before the write, so a failed read cannot leave the operation stacked behind an unfinished confirmation.
		const sources = await readSimulationInputSources(settings)
		// An operation already on the stack was appended by an earlier attempt of this confirmation, which may now finish.
		const interceptorTransactionStack = await updateInterceptorTransactionStack((previousStack) => previousStack.operations.some((stacked) => isSameStackOperation(stacked, operation))
			? previousStack
			: { operations: [...previousStack.operations, operation] })
		// The confirmation reports the stacked operation, which an earlier attempt may have prepared differently.
		const stackedOperation = interceptorTransactionStack.operations.find((stacked) => isSameStackOperation(stacked, operation)) ?? operation
		return { stackedOperation, settings, simulation: buildSimulationSnapshot(settings, sources, interceptorTransactionStack), services: simulationServicesOwner.getCurrent() }
	})
}

// Compares with the installed client rather than the previous settings, so a transition that failed part-way is repaired by its retry. A signer-only network keeps the previous provider because it has no endpoint to install.
async function installServicesForCommittedNetwork(simulationServicesOwner: SimulationServicesOwner, committedRpcNetwork: RpcNetwork) {
	if (committedRpcNetwork.httpsRpc === undefined) return
	if (!getRpcNetworkChange(simulationServicesOwner.getCurrent().ethereum.getRpcEntry(), committedRpcNetwork).endpointChanged) return
	try {
		simulationServicesOwner.reset(committedRpcNetwork)
	} catch (error) {
		// Only failed provider installation invalidates simulation output here.
		await publishFailedPopupVisualisation()
		throw error
	}
}

type CommittedNetworkEffects = {
	readonly installServices: (updatedSettings: Settings) => Promise<void>
	readonly clearStackForChangedChain: (updatedSettings: Settings) => Promise<void>
	readonly notifyChainChange: (updatedSettings: Settings) => Promise<void>
}

// Runs settings writes that may commit a new network; each effect of the committed network is compared with the settings from before the transition. If the transition fails, every effect that has not succeeded is retried before the lock is released and, if one still fails, kept for the next lock holder; the transition's own error is kept.
async function runSettingsTransition(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	transition: (settingsBeforeTransition: Settings, effects: CommittedNetworkEffects) => Promise<void>,
) {
	await runNetworkTransition(async () => {
		const settingsBeforeTransition = await getSettings()
		const change: CommittedNetworkChange = { simulationServicesOwner, websiteTabConnections, settingsBeforeTransition, completedEffects: new Set() }
		const effects: CommittedNetworkEffects = {
			installServices: async (updatedSettings) => await runNetworkChangeEffect(change, 'installServices', updatedSettings),
			clearStackForChangedChain: async (updatedSettings) => await runNetworkChangeEffect(change, 'clearStackForChangedChain', updatedSettings),
			notifyChainChange: async (updatedSettings) => {
				await runNetworkChangeEffect(change, 'notifyWebsitesOfChainChange', updatedSettings)
				await runNetworkChangeEffect(change, 'notifyPopupsOfChainChange', updatedSettings)
			},
		}
		try {
			await transition(settingsBeforeTransition, effects)
		} catch (error) {
			unfinishedNetworkChange = change
			try {
				await completeUnfinishedNetworkChange()
			} catch (repairError: unknown) {
				await reportUnexpectedError(repairError)
			}
			throw error
		}
	})
}

// Notifies popups and approved websites inside the lock, so they see network changes in commit order; the installed services already match the committed network.
async function publishCommittedSettingsChange(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, effects: CommittedNetworkEffects, previousSettings: Settings, updatedSettings: Settings) {
	const { endpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await effects.notifyChainChange(updatedSettings)
	// External-wallet signing has no simulated stack; Safe signing retains its separate stack visualization.
	if ((updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (endpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))) {
		await queuePopupSimulationRefresh(simulationServicesOwner.getCurrent())
	}
	await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
}

// An RPC list update can make another endpoint the active chain's primary. Settings then select that primary together with its services, like a switch to it would; a signer-only selection has no endpoint to replace.
export async function selectUpdatedPrimaryRpcTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections) {
	await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (previousSettings, effects) => {
		if (isSignerOnlyNetwork(previousSettings.activeRpcNetwork)) return
		const primary = await getPrimaryRpcForChain(previousSettings.activeRpcNetwork.chainId)
		if (primary === undefined || !getRpcNetworkChange(previousSettings.activeRpcNetwork, primary).endpointChanged) return
		await changeSimulationMode({ simulationMode: previousSettings.simulationMode, rpcNetwork: primary })
		const updatedSettings = await getSettings()
		try {
			await effects.installServices(updatedSettings)
		} finally {
			// Publish committed settings even if installing their services fails.
			await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration() })
		}
		await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, previousSettings, updatedSettings)
	})
}

// An import can change the active network like a switch does; the popup handler then reconciles website approvals and publishes the imported settings.
export async function importSettingsTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, exportedSettings: ExportedSettings) {
	await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (settingsBeforeImport, effects) => {
		await importSettingsAndAddressBook(exportedSettings)
		const importedSettings = await getSettings()
		await effects.installServices(importedSettings)
		await effects.clearStackForChangedChain(importedSettings)
		await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, settingsBeforeImport, importedSettings)
	})
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
		await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (previousSettings, effects) => {
			// These writes keep the network, mode and stack context of the settings read before the transition.
			if (transition.simulationSignerSelection !== undefined) {
				const { useSignerAddress, signerAddress } = transition.simulationSignerSelection
				await setUseSignersAddressAsActiveAddress(useSignerAddress, signerAddress)
			}
			if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressForRichList()

			if (change.simulationMode) {
				await changeSimulationMode({
					simulationMode: change.simulationMode,
					...('activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}),
					...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
				})
			} else {
				if ('activeAddress' in change && change.signingAddressSelection === undefined) throw new Error('Signing address changes must identify whether the selection is the signer or a Safe.')
				const selectsSafe = change.signingAddressSelection === 'safe'
				await changeSimulationMode({
					simulationMode: change.simulationMode,
					...(!selectsSafe && 'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
					...('activeAddress' in change ? { activeSigningSafeAddress: selectsSafe ? change.activeAddress : undefined } : {}),
					...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
				})
			}

			const updatedSettings = await getSettings()
			try {
				try {
					// The preference belongs to the committed selection, even if later provider preparation fails.
					if (transition.signingPreference !== undefined) await rememberSigningAddressSelection(transition.signingPreference)
					await effects.installServices(updatedSettings)
					await effects.clearStackForChangedChain(updatedSettings)
				} finally {
					// Publish committed settings even if installing their services fails.
					await sendPopupMessageToOpenWindows({
						method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration(),
					})
				}
			} finally {
				accessUpdate = await reconcileWebsiteApprovalAccesses(websiteTabConnections, updatedSettings)
			}
			await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, previousSettings, updatedSettings)
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
): Promise<void> {
	return await runActiveSettingsChange(simulationServicesOwner, websiteTabConnections, { change })
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
	})
}
