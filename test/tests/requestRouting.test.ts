import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getNetworkWithoutRpcWarningState, type SignerAvailability } from '../../app/ts/utils/requestRouting.js'

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
