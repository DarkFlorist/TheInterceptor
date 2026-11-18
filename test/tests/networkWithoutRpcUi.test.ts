import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getNetworkWithoutRpcWarningState, getNetworkWithoutRpcWarningText, getTabSignerAvailability, type SignerAvailability } from '../../app/ts/utils/networkWithoutRpcUi.js'

const networkWithRpc = { httpsRpc: 'https://example.invalid' }
const networkWithoutRpc = { httpsRpc: undefined }
const signerAvailabilities: readonly SignerAvailability[] = ['available', 'missing', 'unknown']

describe('getNetworkWithoutRpcWarningState', () => {
	test('has nothing to warn about on a network with an RPC, whatever the signer state', () => {
		for (const simulationMode of [true, false]) {
			for (const signerAvailability of signerAvailabilities) {
				assert.deepEqual(getNetworkWithoutRpcWarningState(networkWithRpc, simulationMode, signerAvailability), { kind: 'none' })
			}
		}
	})

	test('simulation mode keeps intercepting without an RPC, whatever the signer state', () => {
		for (const signerAvailability of signerAvailabilities) {
			assert.deepEqual(getNetworkWithoutRpcWarningState(networkWithoutRpc, true, signerAvailability), { kind: 'noRpcNeedsConfig' })
		}
	})

	test('signing mode bypasses the Interceptor without an RPC when a signer is available', () => {
		assert.deepEqual(getNetworkWithoutRpcWarningState(networkWithoutRpc, false, 'available'), { kind: 'noRpcBypassToSigner' })
	})

	test('signing mode keeps intercepting without an RPC when no signer is available', () => {
		assert.deepEqual(getNetworkWithoutRpcWarningState(networkWithoutRpc, false, 'missing'), { kind: 'noRpcNeedsConfig' })
	})

	test('signing mode only may bypass the Interceptor without an RPC when the signer is unknown', () => {
		assert.deepEqual(getNetworkWithoutRpcWarningState(networkWithoutRpc, false, 'unknown'), { kind: 'noRpcMayBypass' })
	})
})

describe('getNetworkWithoutRpcWarningText', () => {
	test('asks for an RPC when the Interceptor keeps intercepting', () => {
		assert.equal(getNetworkWithoutRpcWarningText('Signer only', { kind: 'noRpcNeedsConfig' }), 'Signer only has no configured RPC. Select or configure an RPC for Signer only.')
	})

	test('says the Interceptor is disabled when requests go to the signer', () => {
		assert.equal(getNetworkWithoutRpcWarningText('Signer only', { kind: 'noRpcBypassToSigner' }), 'Signer only is not a supported network. The Interceptor is disabled while you are using Signer only.')
	})

	test('explains both outcomes when the signer is unknown', () => {
		assert.equal(getNetworkWithoutRpcWarningText('Signer only', { kind: 'noRpcMayBypass' }), 'Signer only has no configured RPC. Until one is configured, the Interceptor cannot simulate requests on Signer only; in signing mode with a connected wallet they go to the wallet directly.')
	})
})

describe('getTabSignerAvailability', () => {
	// The routing forwards by whether the page has a wallet to forward to, which the tab stores as signerConnected; a named wallet the page cannot forward to is still missing.
	test('takes the availability from signerConnected, not the signer name', () => {
		assert.equal(getTabSignerAvailability({ signerConnected: true }), 'available')
		assert.equal(getTabSignerAvailability({ signerConnected: false }), 'missing')
		assert.equal(getTabSignerAvailability(undefined), 'missing')
	})

	test('is the signer availability of every view of the no-RPC routing', async () => {
		for (const path of ['app/ts/components/pages/Home.tsx', 'app/ts/background/iconHandler.ts']) {
			const source = await Bun.file(path).text()
			assert.match(source, /getNetworkWithoutRpcWarningState\([^)]*getTabSignerAvailability\(tabState\)\)/, path)
		}
	})
})
