import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getNextRpcRetryAt, getRpcWarningState, noNewBlockForOverTwoMins, shouldOfferBundledRpcReset, shouldShowRpcWarningCountdown } from '../../app/ts/utils/rpcConnectionUi.js'

const rpcNetwork = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

function makeBlock(timestamp: Date, number = 123n) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1234n,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp,
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

describe('rpcConnectionUi', () => {
	test('does not offer to reset the bundled singleton RPC list to itself', () => {
		assert.equal(shouldOfferBundledRpcReset([rpcNetwork], [rpcNetwork]), false)
	})

	test('offers to restore the bundled RPC list when only a custom RPC remains', () => {
		const customRpcNetwork = {
			...rpcNetwork,
			name: 'Custom Chain',
			httpsRpc: 'https://custom.example.invalid',
		}

		assert.equal(shouldOfferBundledRpcReset([customRpcNetwork], [rpcNetwork]), true)
	})

	test('treats an active disconnect as an immediate warning with a retry countdown', () => {
		const status = {
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: true,
		}

		const warningState = getRpcWarningState(status)
		const nextRetryAt = getNextRpcRetryAt(status)

		assert.equal(warningState.kind, 'disconnected')
		assert.equal(warningState.retryState, 'active')
		assert.equal(nextRetryAt?.toISOString(), '2024-01-01T00:00:12.000Z')
		assert.equal(shouldShowRpcWarningCountdown(warningState, new Date('2024-01-01T00:00:01.000Z')), true)
	})

	test('treats a paused disconnect as an immediate warning without a countdown', () => {
		const status = {
			isConnected: false,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:00.000Z'),
			latestBlock: undefined,
			rpcNetwork,
			retrying: false,
		}

		const warningState = getRpcWarningState(status)

		assert.equal(warningState.kind, 'disconnected')
		assert.equal(warningState.retryState, 'paused')
		assert.equal(shouldShowRpcWarningCountdown(warningState, new Date('2024-01-01T00:00:01.000Z')), false)
	})

	test('treats a stalled connection with an upcoming retry as unhealthy and countdown-capable', () => {
		const status = {
			isConnected: true,
			lastConnnectionAttempt: new Date('2024-01-01T00:02:30.000Z'),
			latestBlock: makeBlock(new Date('2024-01-01T00:00:00.000Z')),
			rpcNetwork,
			retrying: true,
		}

		const warningState = getRpcWarningState(status)

		assert.equal(noNewBlockForOverTwoMins(status), true)
		assert.equal(warningState.kind, 'stalled')
		assert.equal(warningState.retryState, 'active')
		assert.equal(shouldShowRpcWarningCountdown(warningState, new Date('2024-01-01T00:02:31.000Z')), true)
	})

	test('keeps a stalled connection unhealthy after the retry deadline passes', () => {
		const status = {
			isConnected: true,
			lastConnnectionAttempt: new Date('2024-01-01T00:02:30.000Z'),
			latestBlock: makeBlock(new Date('2024-01-01T00:00:00.000Z')),
			rpcNetwork,
			retrying: true,
		}

		const warningState = getRpcWarningState(status)

		assert.equal(warningState.kind, 'stalled')
		assert.equal(shouldShowRpcWarningCountdown(warningState, new Date('2024-01-01T00:02:43.000Z')), false)
	})

	test('returns no warning for a healthy connected state', () => {
		const status = {
			isConnected: true,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:12.000Z'),
			latestBlock: makeBlock(new Date('2024-01-01T00:00:00.000Z')),
			rpcNetwork,
			retrying: false,
		}

		const warningState = getRpcWarningState(status)

		assert.equal(warningState.kind, 'none')
		assert.equal(warningState.retryState, 'paused')
	})

	test('treats a slow request on a healthy connection as a warning', () => {
		const status = {
			isConnected: true,
			lastConnnectionAttempt: new Date('2024-01-01T00:00:12.000Z'),
			latestBlock: makeBlock(new Date('2024-01-01T00:00:00.000Z')),
			rpcNetwork,
			retrying: true,
			slowRequest: {
				method: 'eth_call',
				startedAt: new Date('2024-01-01T00:00:01.000Z'),
			},
		}

		const warningState = getRpcWarningState(status)

		assert.equal(warningState.kind, 'slowRequest')
		if (warningState.kind !== 'slowRequest') throw new Error('expected a slow request warning')
		assert.equal(warningState.slowRequest.method, 'eth_call')
		assert.equal(shouldShowRpcWarningCountdown(warningState, new Date('2024-01-01T00:00:13.000Z')), false)
	})

	test('shows slow request warnings before stale-block warnings', () => {
		const status = {
			isConnected: true,
			lastConnnectionAttempt: new Date('2024-01-01T00:03:00.000Z'),
			latestBlock: makeBlock(new Date('2024-01-01T00:00:00.000Z')),
			rpcNetwork,
			retrying: true,
			slowRequest: {
				method: 'eth_call',
				startedAt: new Date('2024-01-01T00:02:45.000Z'),
			},
		}

		const warningState = getRpcWarningState(status)

		assert.equal(noNewBlockForOverTwoMins(status), true)
		assert.equal(warningState.kind, 'slowRequest')
		if (warningState.kind !== 'slowRequest') throw new Error('expected a slow request warning')
		assert.equal(warningState.slowRequest.method, 'eth_call')
	})
})
