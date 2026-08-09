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
import { changeSimulationMode, getSettings, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { getUserAddressBookEntries, getUserAddressBookEntriesForChainIdMorePreciseFirst, promoteRpcAsPrimary, updateTransactionState } from './storageVariables.js'

export async function resetSimulationStateFromConfig(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updateTransactionState(() => ({
		interceptorTransactionStack: { operations: [] },
		safeTransactionStacks: [],
	}))
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
		const activeChainId = change.rpcNetwork?.chainId ?? (await getSettings()).activeRpcNetwork.chainId
		const [allEntries, activeChainEntries] = await Promise.all([
			getUserAddressBookEntries(),
			getUserAddressBookEntriesForChainIdMorePreciseFirst(activeChainId),
		])
		const selectedSafe = change.activeAddress === undefined
			? undefined
			: allEntries.find((entry) => entry.type === 'safe' && entry.address === change.activeAddress)
		const safeEntryOnActiveChain = change.activeAddress === undefined
			? undefined
			: activeChainEntries.find((entry) => entry.address === change.activeAddress && entry.type === 'safe')
		await changeSimulationMode({
			simulationMode: change.simulationMode,
			...(selectedSafe === undefined && 'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
			...(selectedSafe !== undefined && safeEntryOnActiveChain === undefined ? { activeSigningAddress: undefined } : {}),
			...('activeAddress' in change ? { activeSimulationAddress: safeEntryOnActiveChain?.address } : {}),
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
