import { ConnectedToSigner, ProviderMessage, WalletSwitchEthereumChainReply, TabState, Settings } from '../utils/interceptor-messages.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/wire-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { setSignerName, updateTabState } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'

export async function ethAccountsReply(port: browser.runtime.Port, request: ProviderMessage, settings: Settings) {
	if (!('params' in request.options)) return
	const signerAccounts = EthereumAccountsReply.parse(request.options.params)
	if (port.sender?.tab?.id !== undefined) {
		await updateTabState(port.sender.tab.id, async (previousState: TabState) => {
			return {
				...previousState,
				signerAccounts: signerAccounts,
			}
		})
	}
	sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket: getSocketFromPort(port)} })

	// update active address if we are using signers address
	if (settings.useSignersAddressAsActiveAddress || settings.simulationMode === false) {
		await changeActiveAddressAndChainAndResetSimulation(signerAccounts[0], 'noActiveChainChange', settings)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
}

async function changeSignerChain(port: browser.runtime.Port, signerChain: bigint, settings: Settings) {
	if ( port.sender?.tab?.id !== undefined ) {
		await updateTabState(port.sender.tab.id, async (previousState: TabState) => {
			return {
				...previousState,
				signerChain: signerChain,
			}
		})
	}

	// update active address if we are using signers address
	if (!settings.simulationMode) {
		return changeActiveAddressAndChainAndResetSimulation('noActiveAddressChange', signerChain, settings)
	}
	sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(port: browser.runtime.Port, request: ProviderMessage, settings: Settings) {
	if (!('params' in request.options)) return
	const signerChain = EthereumChainReply.parse(request.options.params)[0]
	await changeSignerChain(port, signerChain, settings)
}

export async function walletSwitchEthereumChainReply(port: browser.runtime.Port, request: ProviderMessage, settings: Settings) {
	const params = WalletSwitchEthereumChainReply.parse(request.options).params[0]
	if (params.accept) await changeSignerChain(port, params.chainId, settings)
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		options: {
			chainId: params.chainId,
			accept: params.accept,
		}
	})
}

export async function connectedToSigner(_port: browser.runtime.Port, request: ProviderMessage) {
	await setSignerName(ConnectedToSigner.parse(request.options).params[0])
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
}
