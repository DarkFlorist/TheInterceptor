import { ConnectedToSigner, WalletSwitchEthereumChainReply } from '../utils/interceptor-messages.js'
import { TabState, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/JsonRpc-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getRpcNetworkForChain, getTabState, setSignerName, updateTabState } from './storageVariables.js'
import { getMetamaskCompatibilityMode, getSettings } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'
import { ApprovalState } from './accessManagement.js'
import { ProviderMessage } from '../utils/requests.js'
import { sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'
import { Simulator } from '../simulation/simulator.js'

export async function ethAccountsReply(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, _connectInfoapproval: ApprovalState) {
	const returnValue = { method: 'eth_accounts_reply' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	if (port.sender?.tab?.id === undefined) return returnValue

	const signerAccountsReply = EthereumAccountsReply.parse(request.params)
	const signerAccounts = signerAccountsReply[0]
	const activeSigningAddress = signerAccounts.length > 0 ? signerAccounts[0] : undefined
	const tabStateChange = await updateTabState(port.sender.tab.id, (previousState: TabState) => {
		return {
			...previousState,
			signerAccounts: signerAccounts,
			activeSigningAddress: activeSigningAddress,
		}
	})
	sendPopupMessageToOpenWindows({ method: 'popup_activeSigningAddressChanged', data: { tabId: port.sender.tab.id, activeSigningAddress } })
	sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket: getSocketFromPort(port) } })
	// update active address if we are using signers address
	const settings = await getSettings()
	if ((settings.useSignersAddressAsActiveAddress && settings.activeSimulationAddress !== signerAccounts[0])
	|| (settings.simulationMode === false && tabStateChange.previousState.activeSigningAddress !== tabStateChange.newState.activeSigningAddress)) {
		await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: settings.simulationMode,
			activeAddress: tabStateChange.newState.activeSigningAddress,
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	}
	return returnValue
}

async function changeSignerChain(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, signerChain: bigint, approval: ApprovalState) {
	if (approval !== 'hasAccess') return
	if (port.sender?.tab?.id === undefined) return
	if ((await getTabState(port.sender.tab.id)).signerChain === signerChain) return

	await updateTabState(port.sender.tab.id, (previousState: TabState) => {
		return {
			...previousState,
			signerChain: signerChain,
		}
	})

	// update active address if we are using signers address
	const settings = await getSettings()
	if ((settings.useSignersAddressAsActiveAddress || !settings.simulationMode) && settings.rpcNetwork.chainId !== signerChain) {
		return changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
			simulationMode: settings.simulationMode,
			rpcNetwork: await getRpcNetworkForChain(signerChain),
		})
	}
	sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState) {
	const returnValue = { method: 'signer_chainChanged' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	const signerChain = EthereumChainReply.parse(request.params)[0]
	await changeSignerChain(simulator, websiteTabConnections, port, signerChain, approval)
	return returnValue
}

export async function walletSwitchEthereumChainReply(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState) {
	const returnValue = { method: 'wallet_switchEthereumChain_reply' as const, result: '0x' as const }
	if (approval !== 'hasAccess') return returnValue
	const params = WalletSwitchEthereumChainReply.parse(request).params[0]
	if (params.accept) await changeSignerChain(simulator, websiteTabConnections, port, params.chainId, approval)
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		data: {
			chainId: params.chainId,
			accept: params.accept,
		}
	})
	return returnValue
}

export async function connectedToSigner(_simulator: Simulator, _websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState) {
	await setSignerName(ConnectedToSigner.parse(request).params[0])
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
	const settings = await getSettings()
	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		if (approval === 'hasAccess') {
			sendSubscriptionReplyOrCallBackToPort(port, { method: 'request_signer_to_eth_requestAccounts' as const, result: [] })
		} else {
			sendSubscriptionReplyOrCallBackToPort(port, { method: 'request_signer_to_eth_accounts' as const, result: [] })
		}
		sendSubscriptionReplyOrCallBackToPort(port, { method: 'request_signer_chainId' as const, result: [] })
	}
	return { method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() } }
}
