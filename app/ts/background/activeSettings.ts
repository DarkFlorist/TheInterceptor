import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { sendCallbackToConfirmedSignerOwner } from './signerStateOwnership.js'
import { changeSimulationMode, getSettings, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { promoteRpcAsPrimary, updateTransactionState } from './storageVariables.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'

export async function resetSimulationStateFromConfig(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const settings = await getSettings()
	await updateTransactionState((previousState) => {
		if (settings.simulationMode) {
			return {
				interceptorTransactionStack: {
					operations: previousState.interceptorTransactionStack.operations.filter((operation) =>
						operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined
					),
				},
				safeTransactionStacks: previousState.safeTransactionStacks,
			}
		}
		const activeSafeAddress = settings.activeSigningSafeAddress
		const activeChainId = settings.activeRpcNetwork.chainId
		return {
			interceptorTransactionStack: {
				operations: previousState.interceptorTransactionStack.operations.filter((operation) => {
					if (operation.type !== 'Transaction') return true
					const safeTransaction = operation.preSimulationTransaction.safeTransaction
					return safeTransaction === undefined
						|| safeTransaction.safeTx.domain.verifyingContract !== activeSafeAddress
						|| operation.preSimulationTransaction.simulationOptions?.requiredChainId !== activeChainId
				}),
			},
			safeTransactionStacks: previousState.safeTransactionStacks.filter((stack) =>
				stack.safeAddress !== activeSafeAddress || stack.chainId !== activeChainId
			),
		}
	})
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false)
}

const keepTrackOfPreviousAddressForRichList = async () => {
	const previousActiveAddress = (await getSettings()).activeSimulationAddress
	await trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress)
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChain(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		signingAddressSelection?: 'signer' | 'safe',
		rpcNetwork?: RpcNetwork,
		promptForAccessesIfNeeded?: boolean,
	},
) {
	if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressForRichList()
	const previousSettings = change.rpcNetwork !== undefined ? await getSettings() : undefined

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
	const popupRefreshGeneration = await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, updatedSettings, change.promptForAccessesIfNeeded ?? true)
	sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration })
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await changeActiveAddressAndChainSemaphore.execute(async () => {
		if (change.rpcNetwork !== undefined) {
			const rpcChainChanged = previousSettings !== undefined && previousSettings.activeRpcNetwork.chainId !== change.rpcNetwork.chainId
			if (change.rpcNetwork.httpsRpc !== undefined) resetSimulationServices(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged', result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })

			if (updatedSettings.simulationMode && rpcChainChanged) {
				await resetSimulationStateFromConfig(ethereum, tokenPriceService)
			} else if (updatedSettings.simulationMode) {
				await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false)
			}
		}
		await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function activateAddressSelection(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	selection: ActiveAddressSelection | undefined,
	options: {
		readonly simulationMode: boolean
		readonly signerAddress: bigint | undefined
		readonly rpcNetwork?: RpcNetwork
		readonly promptForAccessesIfNeeded?: boolean
	},
) {
	const useSignerAddress = selection?.type === 'signer' || (!options.simulationMode && selection === undefined)
	if (options.simulationMode) {
		await setUseSignersAddressAsActiveAddress(useSignerAddress, useSignerAddress ? selection?.type === 'signer' ? selection.address : options.signerAddress : undefined)
	}
	await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
		simulationMode: options.simulationMode,
		activeAddress: selection?.type === 'signer' ? selection.address : selection?.entry.address,
		...(!options.simulationMode ? { signingAddressSelection: selection?.type === 'addressBookEntry' && selection.entry.type === 'safe' ? 'safe' as const : 'signer' as const } : {}),
		...(options.rpcNetwork === undefined ? {} : { rpcNetwork: options.rpcNetwork }),
		...(options.promptForAccessesIfNeeded === undefined ? {} : { promptForAccessesIfNeeded: options.promptForAccessesIfNeeded }),
	})
	if (options.simulationMode || options.signerAddress === undefined || selection === undefined) return
	if (selection.type === 'signer') {
		await rememberSigningAddressSelection({ signerAddress: options.signerAddress, selection: 'signer' })
		return
	}
	if (selection.entry.type !== 'safe') throw new Error('Signing mode can only activate the external signer or an owned Gnosis Safe.')
	await rememberSigningAddressSelection({
		signerAddress: options.signerAddress,
		selection: 'safe',
		safeAddress: selection.entry.address,
		chainId: selection.entry.chainId,
	})
}

export async function changeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean, signerTabId: number | undefined) {
	if (simulationMode) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'completedLocally' as const }
	}
	if (rpcNetwork.chainId === (await getSettings()).activeRpcNetwork.chainId) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'signerRequestNotNeeded' as const }
	}
	const signerStateToken = signerTabId !== undefined
		&& sendCallbackToConfirmedSignerOwner(websiteTabConnections, signerTabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	const settings = await getSettings()
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration })
	await promoteRpcAsPrimary(rpcNetwork)
	return signerStateToken === false
		? { type: 'signerUnavailable' as const }
		: { type: 'signerRequestSent' as const, signerStateToken }
}
