import { ConnectedToSigner, ProviderMessage, WalletSwitchEthereumChainReply, TabState } from '../utils/interceptor-messages.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/wire-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { saveSignerName, updateTabState } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'

export async function ethAccountsReply(port: browser.runtime.Port, request: ProviderMessage) {
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
	if (globalThis.interceptor.settings?.useSignersAddressAsActiveAddress || globalThis.interceptor.settings?.simulationMode === false) {
		await changeActiveAddressAndChainAndResetSimulation(signerAccounts[0], 'noActiveChainChange')
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
}

async function changeSignerChain(port: browser.runtime.Port, signerChain: bigint ) {
	if ( port.sender?.tab?.id !== undefined ) {
		await updateTabState(port.sender.tab.id, async (previousState: TabState) => {
			return {
				...previousState,
				signerChain: signerChain,
			}
		})
	}

	// update active address if we are using signers address
	if ( !globalThis.interceptor.settings?.simulationMode ) {
		return changeActiveAddressAndChainAndResetSimulation('noActiveAddressChange', signerChain)
	}
	sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	const signerChain = EthereumChainReply.parse(request.options.params)[0]
	await changeSignerChain(port, signerChain)
}

export async function walletSwitchEthereumChainReply(port: browser.runtime.Port, request: ProviderMessage) {
	const params = WalletSwitchEthereumChainReply.parse(request.options).params[0]
	if (params.accept) changeSignerChain(port, params.chainId )
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		options: {
			chainId: params.chainId,
			accept: params.accept,
		}
	})
}

export async function connectedToSigner(_port: browser.runtime.Port, request: ProviderMessage) {
	await saveSignerName(ConnectedToSigner.parse(request.options).params[0])
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
}
