import { ConnectedToSigner, ProviderMessage, WalletSwitchEthereumChainReply, TabState } from '../utils/interceptor-messages.js'
import { WebsiteTabConnections } from '../utils/user-interface-types.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/JSONRPC-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getTabState, setSignerName, updateTabState } from './storageVariables.js'
import { getSettings } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'

export async function ethAccountsReply(websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	if (port.sender?.tab?.id === undefined) return

	const signerAccounts = EthereumAccountsReply.parse(request.options.params)
	await updateTabState(port.sender.tab.id, (previousState: TabState) => {
		return {
			...previousState,
			signerAccounts: signerAccounts,
		}
	})
	sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket: getSocketFromPort(port) } })
	// update active address if we are using signers address
	const settings = await getSettings()
	if ( (settings.useSignersAddressAsActiveAddress && settings.activeSimulationAddress !== signerAccounts[0])
	|| (settings.simulationMode === false && settings.activeSigningAddress !== signerAccounts[0])) {
		await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: settings.simulationMode,
			activeAddress: signerAccounts[0],
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	}
}

async function changeSignerChain(websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, signerChain: bigint) {
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
	if ( (settings.useSignersAddressAsActiveAddress || !settings.simulationMode) && settings.activeChain !== signerChain) {
		return changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
			simulationMode: settings.simulationMode,
			activeChain: signerChain,
		})
	}
	sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	const signerChain = EthereumChainReply.parse(request.options.params)[0]
	await changeSignerChain(websiteTabConnections, port, signerChain)
}

export async function walletSwitchEthereumChainReply(websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage) {
	const params = WalletSwitchEthereumChainReply.parse(request.options).params[0]
	if (params.accept) await changeSignerChain(websiteTabConnections, port, params.chainId)
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		options: {
			chainId: params.chainId,
			accept: params.accept,
		}
	})
}

export async function connectedToSigner(_websiteTabConnections: WebsiteTabConnections, _port: browser.runtime.Port, request: ProviderMessage) {
	await setSignerName(ConnectedToSigner.parse(request.options).params[0])
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
}
