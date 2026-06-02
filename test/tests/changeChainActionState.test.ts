import * as assert from 'assert'
import { describe, test } from 'bun:test'

import { getChangeChainActionState } from '../../app/ts/components/pages/ChangeChain.js'

describe('change chain action state', () => {
	test('allows supported chains', () => {
		assert.deepEqual(
			getChangeChainActionState({
				hasSupportedRpc: true,
				simulationMode: false,
			}),
			{
				approveButtonText: 'Change chain',
				errorText: undefined,
				approveDisabled: false,
			},
		)
	})

	test('explains unsupported simulation-mode chains without promising disable support', () => {
		assert.deepEqual(
			getChangeChainActionState({
				hasSupportedRpc: false,
				simulationMode: true,
			}),
			{
				approveButtonText: 'Change chain unavailable',
				errorText: 'This chain is not supported by The Interceptor in Simulation mode. Switch to Signing mode and try again if you want to continue without simulation protection.',
				approveDisabled: true,
			},
		)
	})

	test('explains unsupported signing-mode chains without a dead disable path', () => {
		assert.deepEqual(
			getChangeChainActionState({
				hasSupportedRpc: false,
				simulationMode: false,
			}),
			{
				approveButtonText: 'Change chain unavailable',
				errorText: 'This chain is not supported by The Interceptor. This dialog cannot disable it for you. If you want to continue without its protection, disable The Interceptor from the main popup and retry the chain change in your wallet.',
				approveDisabled: true,
			},
		)
	})
})
