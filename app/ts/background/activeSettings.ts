import { startPopupSimulationRefreshInBackground } from './popupSimulationRefreshQueue.js'
import type { SimulationServicesOwner, SimulationNetworkReconciliation } from '../simulation/serviceLifecycle.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { runSimulationSettingsTransition } from './simulationSettingsTransition.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './websiteConnectionEvents.js'
import { reconcileWebsiteApprovalAccesses, startWebsiteAccessUiUpdateInBackground } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getSettings, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { changeSimulationMode } from './settings.js'
import { updateTransactionState } from './storageVariables.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { getActiveStackContext, operationBelongsToActiveStackContext } from '../utils/activeStackContext.js'
import { selectionNeedsRefresh, selectionShowsStack } from '../utils/simulationSelection.js'

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

export async function resetSimulationStateFromConfig(simulationServicesOwner: SimulationServicesOwner) {
	await clearSimulationStateFromConfig()
	await startPopupSimulationRefreshInBackground({ ...simulationServicesOwner.getCurrent(), invalidateOldState: true })
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

export async function runActiveSettingsTransition(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	commit: () => Promise<boolean>,
	options: { readonly signingPreference?: SigningAddressPreference, readonly promptForAccessesIfNeeded?: boolean, readonly refreshAlways?: boolean, readonly updateNetworkMetadata?: boolean } = {},
): Promise<void> {
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		// Settings, approvals, resets, notifications and selection preferences form one ordered transition.
		await runSimulationSettingsTransition(simulationServicesOwner, async (servicesUpdate) => {
			const previousSettings = await getSettings()
			if (!await commit()) return

			const updatedSettings = await getSettings()
			const { chainChanged: rpcChainChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
			let networkOutcome: SimulationNetworkReconciliation = 'unchanged'
			try {
				try {
					// The preference belongs to the committed selection, even if later provider preparation fails.
					if (options.signingPreference !== undefined) await rememberSigningAddressSelection(options.signingPreference)
					// A replacement, or its failure, is published by the services update's observer after this transition releases its lock.
					networkOutcome = servicesUpdate.ensureNetwork(updatedSettings.activeRpcNetwork, { updateMetadata: options.updateNetworkMetadata })
					if (updatedSettings.simulationMode && rpcChainChanged) await clearSimulationStateFromConfig()
				} finally {
					// Publish committed settings even if installing their services fails.
					await sendPopupMessageToOpenWindows({
						method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration(),
					})
				}
			} finally {
				accessUpdate = await reconcileWebsiteApprovalAccesses(websiteTabConnections, updatedSettings)
			}
			await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
			if (rpcChainChanged) {
				sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
				await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
			}
			// selectionNeedsRefresh is the same rule by which a refresh queued for the previous selection steps aside, so the change publishes whatever that refresh no longer may. A reconciled endpoint or a settings import also refreshes any selection that shows a stack.
			const reconciliationNeedsRefresh = selectionShowsStack(updatedSettings) && (options.refreshAlways === true || networkOutcome !== 'unchanged')
			if (selectionNeedsRefresh(previousSettings, updatedSettings) || reconciliationNeedsRefresh) {
				servicesUpdate.requestRefresh()
			}
			await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
		})
	} finally {
		// Complete committed access updates after releasing the transition lock, even if a later reset or notification fails.
		if (accessUpdate !== undefined) {
			startWebsiteAccessUiUpdateInBackground(simulationServicesOwner, websiteTabConnections, accessUpdate, options.promptForAccessesIfNeeded ?? true)
		}
	}
}

async function runActiveSettingsChange(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, transition: ActiveSettingsTransition) {
	const { change } = transition
	await runActiveSettingsTransition(simulationServicesOwner, websiteTabConnections, async () => {
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

		return true
	}, { signingPreference: transition.signingPreference, promptForAccessesIfNeeded: change.promptForAccessesIfNeeded })
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
