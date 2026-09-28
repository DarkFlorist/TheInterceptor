import * as assert from 'assert'
import { test } from 'bun:test'
import { runProtectorsForTransaction } from '../../app/ts/simulation/protectorRunner.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { WebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import { DEFAULT_RPCS } from '../../app/ts/config/defaults.js'

test('the uniform protector pipeline retains request-aware fee warnings and ordinary transaction checks', async () => {
	const rpc = DEFAULT_RPCS[0]
	if (rpc === undefined) throw new Error('Missing default RPC')
	const ethereum = new EthereumClientService({
		rpcUrl: rpc.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => rpc.chainId,
		jsonRpcRequest: async (request) => {
			if (request.method !== 'eth_gasPrice') throw new Error(`Unexpected RPC: ${ request.method }`)
			return '0x737be7600' // 31 nanoeth/gas
		},
	}, async () => undefined, async () => undefined, rpc)
	for (const gasPrice of [31n * 10n ** 9n, 310n * 10n ** 9n]) {
		const request: WebsiteCreatedEthereumTransaction = {
			website: { websiteOrigin: 'https://test.example', icon: undefined, title: undefined },
			created: new Date(), transactionIdentifier: 1n, success: true,
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{ gasPrice }] },
			transaction: { type: '1559', from: 1n, to: 2n, nonce: 0n, gas: 21_000n, value: 0n, input: new Uint8Array(), chainId: 99999n, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice },
		}
		const result = await runProtectorsForTransaction({ kind: 'passthrough' }, request, ethereum, undefined, Promise.resolve([]))
		assert.equal(result.quarantine, true)
		assert.equal(result.quarantineReasons.some((reason) => reason.includes('different chain')), true)
		assert.equal(result.quarantineReasons.some((reason) => reason.includes('outrageous fee')), gasPrice === 310n * 10n ** 9n)
	}
})
