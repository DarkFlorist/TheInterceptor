import { createGnosisSafeAppsTestClient, discoverGnosisSafeTestAccount, withGnosisSafeAppsTestDeadline } from './gnosisSafeAppsTestClient.js'

// Parent-based discovery does not support Web3-Onboard's Gnosis Safe connector, which requires a real iframe (self !== top); see test/benchmarks/README.md.
const state: { phase: string, accounts: string[], error?: string } = { phase: 'requesting-safe-only', accounts: [] }
Reflect.set(globalThis, '__interceptorChromeCommunicationState', state)

async function connect() {
	if (window.parent === window) throw new Error('The selected website was not hosted as a Gnosis Safe App.')
	const lido = location.origin === 'https://stake.lido.fi'
	const allowedDomains = lido ? [/^https:\/\/app\.safe\.global$/] : undefined
	const client = createGnosisSafeAppsTestClient({ allowedDomains })
	const start = performance.now()
	const safeInfo = lido ? await withGnosisSafeAppsTestDeadline((signal) => client.getSafeInfo(signal), 200) : await client.getSafeInfo()
	if (lido && performance.now() - start <= 200) throw new Error('Lido fixture must exercise a discovery reply slower than its original deadline.')
	// Exercise a second, independent account discovery with the observed connector deadline.
	const account = await discoverGnosisSafeTestAccount({ allowedDomains, timeout: lido ? 10 : 5_000 })
	if (typeof safeInfo !== 'object' || safeInfo === null || !('safeAddress' in safeInfo) || !('chainId' in safeInfo) || account.safeAddress.toLowerCase() !== String(safeInfo.safeAddress).toLowerCase() || account.chainId !== safeInfo.chainId) throw new Error('Independent Gnosis Safe discovery responses disagreed.')
	Reflect.set(state, 'safeInfo', safeInfo)
	state.accounts = [account.safeAddress]
	state.phase = 'safe-only-granted'
}

void connect().catch((error: unknown) => {
	state.error = error instanceof Error ? error.message : String(error)
	state.phase = 'error'
})
