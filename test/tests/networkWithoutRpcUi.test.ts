import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getNetworkWithoutRpcWarningState, getNetworkWithoutRpcWarningText, type SignerAvailability } from '../../app/ts/utils/networkWithoutRpcUi.js'

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
