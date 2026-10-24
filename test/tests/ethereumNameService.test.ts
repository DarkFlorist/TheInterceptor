import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getEthereumNameServiceNameFromTokenId } from '../../app/ts/utils/ethereumNameService.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { normalizeEnsNameOrUndefined } from '../../app/ts/utils/ens.js'
import { namehash } from '../../app/ts/utils/ethereumPrimitives.js'

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

const createWrappedNamesService = (dnsEncodedName: `0x${ string }`) => new EthereumClientService(
	{
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		async getChainId() { return rpcEntry.chainId },
		async jsonRpcRequest(request) {
			if (request.method !== 'eth_call') throw new Error(`Unexpected RPC method: ${ request.method }`)
			return encodeFunctionReturn(wrappedEnsNamesAbi, 'names', [dnsEncodedName])
		},
	},
	async () => undefined,
	async () => undefined,
	rpcEntry,
)

describe('wrapped ENS name verification', () => {
	test('rejects wrapped names that fail ENS normalization', async () => {
		const invalidEnsName = 'a\u202e.eth'
		const invalidDnsEncodedName = '0x0461e280ae0365746800'
		assert.equal(normalizeEnsNameOrUndefined(invalidEnsName), undefined)

		assert.equal(await getEthereumNameServiceNameFromTokenId(createWrappedNamesService(invalidDnsEncodedName), undefined, 1n), undefined)
	})

	test('decodes every label of a wrapped name that matches the token id', async () => {
		// `sub.vitalik.eth` in DNS wire format: length-prefixed labels ending with a zero-length label.
		const service = createWrappedNamesService('0x0373756207766974616c696b0365746800')

		assert.equal(await getEthereumNameServiceNameFromTokenId(service, undefined, BigInt(namehash('sub.vitalik.eth'))), 'sub.vitalik.eth')
	})
})
