import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { ResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { pendingTransaction, activeAddress, recipientAddress, signedTransaction, created } from './confirmTransactionTestHarness.js'
import { getSiteRpcExecution, getSiteSimulationTokens, getSiteSimulationTokenMetadata } from '../../app/ts/background/siteRpcInterception.js'

test('simulation token discovery exposes only fungible token addresses for the selected account and chain', () => {
	const token = 0x1234567890123456789012345678901234567890n
	const state: ResolvedSimulationState = { kind: 'simulated', value: {
		...pendingTransaction.popupVisualisation.data.simulationState,
		simulatedBlocks: [{ stateOverrides: {}, signedMessages: [], blockTimestamp: created, blockBaseFeePerGas: 0n, blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }, simulatedTransactions: [{
			realizedGasPrice: 0n, preSimulationTransaction: { signedTransaction, website: pendingTransaction.website, created, originalRequestParameters: pendingTransaction.originalRequestParameters, transactionIdentifier: 1n },
			ethSimulateV1CallResult: { status: 'success', gasUsed: 21000n, logs: [], returnData: new Uint8Array() },
			tokenBalancesAfter: [
				{ token, owner: activeAddress, balance: 1n, tokenId: undefined },
				{ token, owner: activeAddress, balance: 2n, tokenId: undefined },
				{ token: 2n, owner: recipientAddress, balance: 3n, tokenId: undefined },
				{ token: 3n, owner: activeAddress, balance: 1n, tokenId: 0n },
				{ token: 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen, owner: activeAddress, balance: 10n, tokenId: undefined },
			],
		}] }],
	} }
	assert.deepEqual(getSiteSimulationTokens(state, activeAddress, state.value.rpcNetwork.chainId), [token])
	assert.deepEqual(getSiteSimulationTokens(state, activeAddress, 137n), [])
	assert.deepEqual(getSiteSimulationTokens(state, 4n, 1n), [])
	assert.deepEqual(getSiteSimulationTokens({ kind: 'passthrough' }, activeAddress, 1n), [])
})

test('simulation token discovery uses the same simulation mode, origin and chain admission as RPC reads', () => {
	const request = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: pendingTransaction.uniqueRequestIdentifier, params: [{ chainId: '0x1', request: { method: 'interceptor_getSimulationTokens' } }] }
	assert.equal(getSiteRpcExecution(request, 'https://unlisted.example', true, 1n)?.kind, 'tokens')
	assert.equal(getSiteRpcExecution(request, 'https://unlisted.example', false, 1n)?.kind, 'rejected')
	assert.equal(getSiteRpcExecution(request, 'file://', true, 1n)?.kind, 'rejected')
	assert.equal(getSiteRpcExecution(request, 'https://unlisted.example', true, 137n)?.kind, 'rejected')
})


test('portfolio metadata exposes only public native/token fields and uses normal simulation admission', async () => {
	const addresses: bigint[] = []
	const metadata = await getSiteSimulationTokenMetadata({ kind: 'passthrough' }, activeAddress, 1n, async (address) => {
		addresses.push(address)
		return { address, type: 'ERC20', name: 'Ether', symbol: 'ETH', decimals: 18n, entrySource: 'Interceptor', chainId: 1n, logoUri: 'private-unused-field' }
	})
	assert.deepEqual(addresses, [0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen])
	assert.deepEqual(metadata, [{ address: addresses[0], name: 'Ether', symbol: 'ETH', decimals: 18n }])
	const request = { method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: pendingTransaction.uniqueRequestIdentifier, params: [{ chainId: '0x1', request: { method: 'interceptor_getSimulationTokenMetadata' } }] }
	const execution = getSiteRpcExecution(request, 'https://unlisted.example', true, 1n)
	assert.ok(execution?.kind === 'tokens')
	assert.equal(execution.includeTokenMetadata, true)
	assert.equal(getSiteRpcExecution(request, 'https://unlisted.example', false, 1n)?.kind, 'rejected')
	assert.equal(getSiteRpcExecution(request, 'https://unlisted.example', true, 137n)?.kind, 'rejected')
})
