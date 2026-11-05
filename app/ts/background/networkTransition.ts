import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import { reportUnexpectedError } from '../utils/errors.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { advanceCommittedNetworkChangeGeneration, getCommittedNetworkChangeGeneration } from './networkChangeGeneration.js'
import { changeSimulationMode, getSettings, importSettingsAndAddressBook } from './settings.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { getPrimaryRpcForChain, updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'
import { type NetworkSnapshot, readSimulationInputSources, type SimulationRead } from './simulationUpdating.js'
import { completeUnfinishedNetworkChange, type LockedNetworkReads, recordUnfinishedNetworkChange, runNetworkTransition } from './networkTransitionLock.js'
import { assertNever } from '../utils/typescript.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext, SIMULATION_STACK_CONTEXT } from '../utils/activeStackContext.js'

// The effects a committed network change owes, run under the lock of networkTransitionLock.ts, and the network snapshots that requests read under the same lock. activeSettings.ts builds address and chain changes on top of it.

async function clearSimulationStackContext() {
	await updateTransactionState((previousState) => ({
		interceptorTransactionStack: {
			operations: previousState.interceptorTransactionStack.operations.filter((operation) => !operationBelongsToActiveStackContext(operation, SIMULATION_STACK_CONTEXT)),
		},
		safeTransactionStacks: previousState.safeTransactionStacks,
	}))
}

type NetworkChangeEffect = 'retireSnapshotsOfReplacedNetwork' | 'installServices' | 'clearStackForChangedChain' | 'notifyWebsitesOfChainChange' | 'notifyPopupsOfChainChange'
const NETWORK_CHANGE_EFFECTS = ['retireSnapshotsOfReplacedNetwork', 'installServices', 'clearStackForChangedChain', 'notifyWebsitesOfChainChange', 'notifyPopupsOfChainChange'] as const

type CommittedNetworkChange = {
	readonly simulationServicesOwner: SimulationServicesOwner
	readonly websiteTabConnections: WebsiteTabConnections
	readonly settingsBeforeTransition: Settings
	readonly completedEffects: Set<NetworkChangeEffect>
}

// Every effect is idempotent or recorded once it succeeds: installation compares with the installed client, clearing the active stack context twice is harmless, the snapshot generation advances and websites are notified once per committed change. Popup notifications are best-effort.
async function runNetworkChangeEffect(change: CommittedNetworkChange, effect: NetworkChangeEffect, updatedSettings: Settings) {
	if (change.completedEffects.has(effect)) return
	const { chainChanged, endpointChanged } = getRpcNetworkChange(change.settingsBeforeTransition.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	switch (effect) {
		case 'retireSnapshotsOfReplacedNetwork': {
			// Snapshots read before this change no longer describe the active network, so shared visualisation refreshes holding one neither simulate nor publish.
			if (chainChanged || endpointChanged) advanceCommittedNetworkChangeGeneration()
			break
		}
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

// Retries the effects that have not succeeded in commit order against the committed settings, so websites hear of the chain only once its state is complete. While one still fails, the completed ones stay recorded in the change and this throws.
async function completeNetworkChangeEffects(change: CommittedNetworkChange) {
	const committedSettings = await getSettings()
	for (const effect of NETWORK_CHANGE_EFFECTS) await runNetworkChangeEffect(change, effect, committedSettings)
}

// The committed network change generation once any transition in progress has finished, so settings read before this call belong to the returned generation or an earlier one.
export async function readCommittedNetworkChangeGeneration() {
	return await runNetworkTransition(async () => getCommittedNetworkChangeGeneration())
}

const isSameStackOperation = (stacked: InterceptorStackOperation, operation: InterceptorStackOperation) => {
	if (stacked.type === 'Transaction' && operation.type === 'Transaction') return stacked.preSimulationTransaction.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
	if (stacked.type === 'Message' && operation.type === 'Message') return stacked.signedMessageTransaction.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
	return false
}

// A confirmed simulation operation joins the stack only while the chain it was simulated on is still active in simulation mode. Returns the stacked operation with the settings, stack snapshot and services read under the same lock, or undefined if that network went away.
export async function appendToActiveSimulationStack(simulationServicesOwner: SimulationServicesOwner, operation: InterceptorStackOperation, simulatedChainId: bigint | undefined): Promise<(NetworkSnapshot & { readonly stackedOperation: InterceptorStackOperation }) | undefined> {
	return await runNetworkTransition(async (reads) => {
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
		return { stackedOperation, settings, simulation: reads.buildSimulationSnapshot(settings, sources, interceptorTransactionStack), services: simulationServicesOwner.getCurrent() }
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

// A popup refresh that a committed change needs: its services and snapshot are read under the lock, and it is simulated after the lock is released, so requests waiting for the lock do not wait for the simulation.
type PendingPopupRefresh = { readonly services: SimulationServices, readonly snapshot: SimulationRead }

// Notifies popups and approved websites inside the lock, so they see network changes in commit order. Only runSettingsTransition calls this, after it has installed the committed network's services and cleared the previous chain's stack. Returns the popup refresh to run after the lock.
async function publishCommittedSettingsChange(reads: LockedNetworkReads, change: CommittedNetworkChange, updatedSettings: Settings): Promise<PendingPopupRefresh | undefined> {
	const previousSettings = change.settingsBeforeTransition
	const { endpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await runNetworkChangeEffect(change, 'notifyWebsitesOfChainChange', updatedSettings)
	await runNetworkChangeEffect(change, 'notifyPopupsOfChainChange', updatedSettings)
	// External-wallet signing has no simulated stack; Safe signing retains its separate stack visualization.
	const needsPopupRefresh = (updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (endpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))
	const popupRefresh = needsPopupRefresh ? { services: change.simulationServicesOwner.getCurrent(), snapshot: (await reads.captureNetworkState()).simulation } : undefined
	await sendActiveAccountChangeToApprovedWebsitePorts(change.websiteTabConnections, await getSettings())
	return popupRefresh
}

type SettingsTransition = {
	// Writes the settings under the lock. Returns 'unchanged' when it decided to write nothing, so nothing is installed or published.
	readonly writeSettings: (settingsBeforeTransition: Settings) => Promise<'committed' | 'unchanged'>
	// Runs after the committed network's services are installed and the previous chain's stack is cleared, also when that failed, and before popups and websites are notified of the change.
	readonly afterNetworkApplied?: (committedSettings: Settings) => Promise<void>
}

// Runs settings writes that may commit a new network, then applies the committed network in the order of NETWORK_CHANGE_EFFECTS: retire snapshots of the replaced network, install its services, clear the previous chain's stack, notify websites and popups. Each effect is compared with the settings from before the transition. The popup refresh the change needs runs after the lock is released. If the transition fails, every effect that has not succeeded is retried before the lock is released and, if one still fails, kept for the next lock holder; the transition's own error is kept.
export async function runSettingsTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, transition: SettingsTransition) {
	const popupRefresh = await runNetworkTransition(async (reads) => {
		const settingsBeforeTransition = await getSettings()
		const change: CommittedNetworkChange = { simulationServicesOwner, websiteTabConnections, settingsBeforeTransition, completedEffects: new Set() }
		try {
			if (await transition.writeSettings(settingsBeforeTransition) === 'unchanged') return undefined
			const committedSettings = await getSettings()
			try {
				await runNetworkChangeEffect(change, 'retireSnapshotsOfReplacedNetwork', committedSettings)
				await runNetworkChangeEffect(change, 'installServices', committedSettings)
				await runNetworkChangeEffect(change, 'clearStackForChangedChain', committedSettings)
			} finally {
				await transition.afterNetworkApplied?.(committedSettings)
			}
			return await publishCommittedSettingsChange(reads, change, committedSettings)
		} catch (error) {
			recordUnfinishedNetworkChange(async () => await completeNetworkChangeEffects(change))
			try {
				await completeUnfinishedNetworkChange()
			} catch (repairError: unknown) {
				await reportUnexpectedError(repairError)
			}
			throw error
		}
	})
	if (popupRefresh !== undefined) await queuePopupSimulationRefresh(popupRefresh.services, popupRefresh.snapshot)
}

// An RPC list update can make another endpoint the active chain's primary. Settings then select that primary together with its services, like a switch to it would; a signer-only selection has no endpoint to replace.
export async function selectUpdatedPrimaryRpcTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections) {
	await runSettingsTransition(simulationServicesOwner, websiteTabConnections, {
		// The new primary is on the active chain, so the transition installs its services but keeps the stack.
		writeSettings: async (previousSettings) => {
			if (isSignerOnlyNetwork(previousSettings.activeRpcNetwork)) return 'unchanged'
			const primary = await getPrimaryRpcForChain(previousSettings.activeRpcNetwork.chainId)
			if (primary === undefined || !getRpcNetworkChange(previousSettings.activeRpcNetwork, primary).endpointChanged) return 'unchanged'
			await changeSimulationMode({ simulationMode: previousSettings.simulationMode, rpcNetwork: primary })
			return 'committed'
		},
		// Publish committed settings even if installing their services fails.
		afterNetworkApplied: async (updatedSettings) => await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration() }),
	})
}

// An import can change the active network like a switch does; the popup handler then reconciles website approvals and publishes the imported settings.
export async function importSettingsTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, exportedSettings: ExportedSettings) {
	await runSettingsTransition(simulationServicesOwner, websiteTabConnections, {
		writeSettings: async () => {
			await importSettingsAndAddressBook(exportedSettings)
			return 'committed'
		},
	})
}
