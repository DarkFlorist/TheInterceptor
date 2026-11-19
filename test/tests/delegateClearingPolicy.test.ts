import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { getSimulationOverridesForPreview, getSimulationPreviewPurpose, type SimulationPreviewContext } from '../../app/ts/background/delegateClearingPolicy.js'
import { changeSimulationMode, getSettings, setDelegateClearingEnabled } from '../../app/ts/background/settings.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'

const activeAddress = 0x1234567890123456789012345678901234567890n
const rpcEntry = {
	name: 'Delegate clearing policy test network',
	chainId: 31337n,
	httpsRpc: 'https://delegate-clearing-policy.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: false,
	minimized: false,
} as const

// One row per place that previews a simulation today, with the context it describes and the purpose it had before the policy derived it.
const callSiteContexts: readonly { readonly callSite: string, readonly context: SimulationPreviewContext, readonly purpose: 'what-if' | 'signing-or-execution' }[] = [
	{ callSite: 'website RPC requests (handleRPCRequest)', context: { kind: 'simulation-stack' }, purpose: 'what-if' },
	{ callSite: 'simulation stack export (requestInterceptorSimulationInput)', context: { kind: 'simulation-stack' }, purpose: 'what-if' },
	{ callSite: 'popup stack visualisation, metadata and refresh (captureSimulationStackSnapshot)', context: { kind: 'simulation-stack' }, purpose: 'what-if' },
	{ callSite: 'governance execution preview (simulateGovernanceContractExecution)', context: { kind: 'governance-execution-on-stack' }, purpose: 'what-if' },
	{ callSite: 'simulation-mode transaction confirmation', context: { kind: 'transaction-confirmation', simulationMode: true, safeSigningRequest: false }, purpose: 'what-if' },
	{ callSite: 'simulation-mode Gnosis Safe transaction confirmation', context: { kind: 'transaction-confirmation', simulationMode: true, safeSigningRequest: true }, purpose: 'signing-or-execution' },
	{ callSite: 'signing-mode transaction confirmation', context: { kind: 'transaction-confirmation', simulationMode: false, safeSigningRequest: false }, purpose: 'signing-or-execution' },
	{ callSite: 'signing-mode Gnosis Safe transaction confirmation', context: { kind: 'transaction-confirmation', simulationMode: false, safeSigningRequest: true }, purpose: 'signing-or-execution' },
	{ callSite: 'transaction formation paid by its sender (formEthSendTransaction)', context: { kind: 'transaction-formation', gasPayment: 'transaction-sender' }, purpose: 'what-if' },
	{ callSite: 'transaction formation through a simulated Gnosis Safe executor', context: { kind: 'transaction-formation', gasPayment: 'simulated-safe-executor' }, purpose: 'what-if' },
	{ callSite: 'transaction formation through an external executor', context: { kind: 'transaction-formation', gasPayment: 'external-executor' }, purpose: 'signing-or-execution' },
	{ callSite: 'Gnosis Safe transaction message signature (simulateGnosisSafeMetaTransaction)', context: { kind: 'safe-transaction-signature' }, purpose: 'signing-or-execution' },
]

describe('delegate clearing policy', () => {
	for (const { callSite, context, purpose } of callSiteContexts) {
		test(`derives ${ purpose } for ${ callSite }`, () => {
			assert.equal(getSimulationPreviewPurpose(context), purpose)
		})
	}

	test('fails closed for a context or gas payment it does not recognise', () => {
		// Parsed from JSON to stand in for a context added later, which the type would otherwise reject.
		const unknownContext: SimulationPreviewContext = JSON.parse('{ "kind": "future-preview" }')
		const unknownGasPayment: SimulationPreviewContext = JSON.parse('{ "kind": "transaction-formation", "gasPayment": "future-payer" }')
		assert.equal(getSimulationPreviewPurpose(unknownContext), 'signing-or-execution')
		assert.equal(getSimulationPreviewPurpose(unknownGasPayment), 'signing-or-execution')
	})

	test('clears the delegate only for what-if previews in simulation mode', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const simulationModeSettings = await getSettings()
		for (const { context, purpose } of callSiteContexts) {
			assert.deepEqual(getSimulationOverridesForPreview(context, simulationModeSettings), purpose === 'what-if' ? { [addressString(activeAddress)]: { code: new Uint8Array() } } : {})
		}
		await changeSimulationMode({ simulationMode: false })
		const signingModeSettings = await getSettings()
		for (const { context } of callSiteContexts) assert.deepEqual(getSimulationOverridesForPreview(context, signingModeSettings), {})
	})

	test('no module other than the policy names or derives a simulation preview purpose', async () => {
		const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
		const offenders: string[] = []
		for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
			if (file === 'background/delegateClearingPolicy.ts') continue
			const source = await Bun.file(`${ sourceDirectory }${ file }`).text()
			if (/['"`](?:what-if|signing-or-execution)['"`]|\bSimulationPreviewPurpose\b|\bgetSimulationPreviewPurpose\b/u.test(source)) offenders.push(file)
		}
		assert.deepEqual(offenders, [])
	})
})
