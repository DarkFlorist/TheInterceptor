import 'webextension-polyfill'
import { getMakeMeRich, getSettings } from './settings.js'
import { getPrependTrasactions, onContentScriptConnected, popupMessageHandler, updateSimulationState } from './background.js'
import { updateExtensionBadge } from './iconHandler.js'
import { clearTabStates, getSimulationResults, removeTabState, setRpcConnectionStatus } from './storageVariables.js'
import { setPrependTransactionsQueue } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Simulator } from '../simulation/simulator.js'
import { TabConnection } from '../utils/user-interface-types.js'
import { EthereumBlockHeader } from '../utils/wire-types.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { refreshSimulation } from './popupMessageHandlers.js'
import { isFailedToFetchError } from '../utils/errors.js'

let simulator: Simulator | undefined = undefined

const websiteTabConnections = new Map<number, TabConnection>()

browser.runtime.onConnect.addListener(port => onContentScriptConnected(simulator, port, websiteTabConnections).catch(console.error))
browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) {
	const rpcConnectionStatus = {
		isConnected: true,
		lastConnnectionAttempt: new Date(),
		latestBlock: blockheader,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
	}
	await setRpcConnectionStatus(rpcConnectionStatus)
	await updateExtensionBadge()
	await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
	if (isNewBlock) {
		const settings = await getSettings()
		await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode ? await refreshSimulation(simulator, ethereumClientService, settings) : undefined, websiteTabConnections)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService, error: Error) {
	if (isFailedToFetchError(error)) {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getLastKnownCachedBlockOrUndefined(),
			rpcNetwork: ethereumClientService.getRpcNetwork(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		return await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	}
	throw error
}

async function startup() {
	const settings = await getSettings()
	if (settings.rpcNetwork.httpsRpc !== undefined) {
		simulator = new Simulator(settings.rpcNetwork, newBlockAttemptCallback, onErrorBlockCallback)
	}
	if (simulator === undefined) throw new Error('simulator not found')
	browser.runtime.onMessage.addListener(async function (message: unknown) {
		if (simulator === undefined) throw new Error('Interceptor not ready yet')
		await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
	})

	await updateExtensionBadge()

	if (settings.simulationMode) {
		// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		const ethereumClientService = simulator.ethereum
		await updateSimulationState(simulator, async () => {
			const simulationState = (await getSimulationResults()).simulationState
			const prependQueue = await getPrependTrasactions(ethereumClientService, settings, await getMakeMeRich())
			return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
		}, settings.activeSimulationAddress, true)
	}
}

startup()
