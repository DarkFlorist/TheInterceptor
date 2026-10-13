import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { safe } from '@wagmi/connectors/safe'
import gnosis from '@web3-onboard/gnosis'

// Gnosis still declares an SDK 8 peer. It is a negative iframe-detection fixture only; real transport uses the pinned SDK 9 and Wagmi.
const state: { phase: string, accounts: string[], error?: string } = { phase: 'requesting-safe-only', accounts: [] }
Reflect.set(globalThis, '__interceptorChromeCommunicationState', state)

async function connect() {
	if (window.parent === window) throw new Error('The selected website was not hosted as a Safe App.')
	// A parent-based host preserves the top-level frame identity used by stricter connectors.
	if (!Array.isArray(gnosis()())) throw new Error('Web3-Onboard unexpectedly detected a real iframe.')
	const sdk = new SafeAppsSDK()
	const safeInfo = await sdk.safe.getInfo()
	// A real transport may exceed Wagmi's 10 ms default even after authorization.
	const connector = safe({ unstable_getInfoTimeout: 5_000 })({ chains: [], emitter: { emit: () => undefined } })
	const accounts = await connector.getAccounts()
	if (accounts[0]?.toLowerCase() !== safeInfo.safeAddress.toLowerCase() || await connector.getChainId() !== safeInfo.chainId) throw new Error('The real SDK and Wagmi disagreed about the selected Safe.')
	Reflect.set(state, 'safeInfo', safeInfo)
	state.accounts = [...accounts]
	state.phase = 'safe-only-granted'
}

void connect().catch((error: unknown) => {
	state.error = error instanceof Error ? error.message : String(error)
	state.phase = 'error'
})
