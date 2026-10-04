import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getEthereumNameServiceNameFromTokenId } from '../../app/ts/utils/ethereumNameService.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { normalizeEnsNameOrUndefined } from '../../app/ts/utils/ens.js'

const rpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
} as const

const wrappedEnsNamesAbi = [{
	type: 'function',
	name: 'names',
	stateMutability: 'view',
	inputs: [{ name: 'node', type: 'bytes32' }],
	outputs: [{ name: 'name', type: 'bytes' }],
}] as const

describe('wrapped ENS name verification', () => {
	test('rejects wrapped names that fail ENS normalization', async () => {
		const invalidEnsName = 'a\u202e.eth'
		const invalidDnsEncodedName = '0x0461e280ae0365746800'
		assert.equal(normalizeEnsNameOrUndefined(invalidEnsName), undefined)
		const service = new EthereumClientService(
			{
				rpcUrl: rpcEntry.httpsRpc,
				clearCache: () => undefined,
				async getChainId() { return rpcEntry.chainId },
				async jsonRpcRequest(request) {
					if (request.method !== 'eth_call') throw new Error(`Unexpected RPC method: ${ request.method }`)
					return encodeFunctionReturn(wrappedEnsNamesAbi, 'names', [invalidDnsEncodedName])
				},
			},
			async () => undefined,
			async () => undefined,
			rpcEntry,
		)

		assert.equal(await getEthereumNameServiceNameFromTokenId(service, undefined, 1n), undefined)
	})
})
