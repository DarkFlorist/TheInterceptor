import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSafeContractRpcEntry, handleSafeContractSnapshotFailure, requestSafeContractState } from '../../app/ts/background/safeContractState.js'
import { createSafeContractValidationFailure } from '../../app/ts/safe/safeCore.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { EthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'

const activeRpc = { name: 'Optimism', chainId: 10n, httpsRpc: 'https://optimism.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const safeRpc = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://ethereum.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }

function createEthereum(rpcEntry = activeRpc) {
	return new EthereumClientService(new EthereumJSONRpcRequestHandler(rpcEntry.httpsRpc), async () => undefined, async () => undefined, rpcEntry)
}

describe('Safe contract state error boundary', () => {
	test('uses the configured RPC for the Safe chain without changing the active chain', async () => {
		const requestedChains: bigint[] = []
		const selectedRpc = await getSafeContractRpcEntry({
			getChainId: () => activeRpc.chainId,
			getRpcEntry: () => activeRpc,
		}, safeRpc.chainId, async (chainId) => {
			requestedChains.push(chainId)
			return safeRpc
		})

		assert.equal(selectedRpc, safeRpc)
		assert.deepEqual(requestedChains, [1n])
	})

	test('reuses the active RPC when it already matches the Safe chain', async () => {
		const ethereumRpc = { ...safeRpc }
		let configuredRpcRequested = false
		const selectedRpc = await getSafeContractRpcEntry({
			getChainId: () => ethereumRpc.chainId,
			getRpcEntry: () => ethereumRpc,
		}, ethereumRpc.chainId, async () => {
			configuredRpcRequested = true
			return undefined
		})

		assert.equal(selectedRpc, ethereumRpc)
		assert.equal(configuredRpcRequested, false)
	})

	test('returns a specific error when the Safe chain has no configured RPC', async () => {
		const ethereum = createEthereum()
		try {
			const result = await requestSafeContractState(ethereum, {
				method: 'popup_requestSafeContractState',
				data: { address: 1n, chainId: safeRpc.chainId },
			}, { getRpcEntry: async () => undefined })

			assert.deepEqual(result.data.result, { ok: false, message: 'Configure an RPC for chain 1 to load this Gnosis Safe\'s owners.' })
		} finally {
			ethereum.cleanup()
		}
	})

	test('uses the temporary cross-chain client for successful owner retrieval', async () => {
		const ethereum = createEthereum()
		const temporaryEthereum = createEthereum(safeRpc)
		try {
			const result = await requestSafeContractState(ethereum, {
				method: 'popup_requestSafeContractState',
				data: { address: 1n, chainId: safeRpc.chainId },
			}, {
				getRpcEntry: async () => safeRpc,
				createTemporaryEthereum: () => temporaryEthereum,
				getSnapshot: async () => ({ blockNumber: 100n, state: { version: '1.4.1', nonce: 0n, owners: [2n], threshold: 1n } }),
				getLocalEntries: async () => [{ type: 'contact', name: 'Owner', address: 2n, entrySource: 'User' }],
			})

			assert.deepEqual(result.data.result, {
				ok: true,
				owners: [2n],
				ownerAddressBookEntries: [{ type: 'contact', name: 'Owner', address: 2n, entrySource: 'User' }],
				version: '1.4.1',
			})
		} finally {
			temporaryEthereum.cleanup()
			ethereum.cleanup()
		}
	})

	test('creates a lightweight Ethereum client for the configured cross-chain RPC', async () => {
		const ethereum = createEthereum()
		let snapshotRpc: typeof safeRpc | undefined
		try {
			const result = await requestSafeContractState(ethereum, {
				method: 'popup_requestSafeContractState',
				data: { address: 1n, chainId: safeRpc.chainId },
			}, {
				getRpcEntry: async () => safeRpc,
				getSnapshot: async (safeEthereum) => {
					snapshotRpc = safeEthereum.getRpcEntry()
					return { blockNumber: 100n, state: { version: '1.4.1', nonce: 0n, owners: [], threshold: 1n } }
				},
				getLocalEntries: async () => [],
			})

			assert.equal(snapshotRpc, safeRpc)
			assert.equal(result.data.result.ok, true)
		} finally {
			ethereum.cleanup()
		}
	})

	test('returns a failure from the temporary cross-chain client', async () => {
		const ethereum = createEthereum()
		const temporaryEthereum = createEthereum(safeRpc)
		const snapshotFailure = createSafeContractValidationFailure('Safe lookup failed.')
		try {
			const result = await requestSafeContractState(ethereum, {
				method: 'popup_requestSafeContractState',
				data: { address: 1n, chainId: safeRpc.chainId },
			}, {
				getRpcEntry: async () => safeRpc,
				createTemporaryEthereum: () => temporaryEthereum,
				getSnapshot: async () => { throw snapshotFailure },
			})

			assert.deepEqual(result.data.result, { ok: false, message: snapshotFailure.message })
		} finally {
			temporaryEthereum.cleanup()
			ethereum.cleanup()
		}
	})

	test('returns a user-facing failure for expected infrastructure errors', async () => {
		let reportCount = 0
		const failure = new Error(NEW_BLOCK_ABORT)
		const result = await handleSafeContractSnapshotFailure(failure, async () => {
			reportCount += 1
		})

		assert.deepEqual(result, { ok: false, message: NEW_BLOCK_ABORT })
		assert.equal(reportCount, 0)
	})

	test('returns a user-facing failure when the address has no deployed Safe contract', async () => {
		let reportCount = 0
		const failure = createSafeContractValidationFailure('The Gnosis Safe address does not contain a deployed contract on the selected chain.')
		const result = await handleSafeContractSnapshotFailure(failure, async () => {
			reportCount += 1
		})

		assert.deepEqual(result, { ok: false, message: failure.message })
		assert.equal(reportCount, 0)
	})

	test('reports and rethrows unexpected snapshot failures', async () => {
		const failure = new Error('Safe owner decoder failed')
		let reportedError: unknown
		let reportedCode: string | undefined

		await assert.rejects(
			async () => await handleSafeContractSnapshotFailure(failure, async (error, metadata) => {
				reportedError = error
				reportedCode = metadata.code
			}),
			(error) => error === failure,
		)
		assert.equal(reportedError, failure)
		assert.equal(reportedCode, 'safe_contract_state_retrieval_failed')
	})
})
