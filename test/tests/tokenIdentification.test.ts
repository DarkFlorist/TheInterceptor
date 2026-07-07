import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { JsonRpcResponse, type EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { Erc20ABI } from '../../app/ts/utils/abi.js'
import { itentifyAddressViaOnChainInformation } from '../../app/ts/utils/tokenIdentification.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

const tokenAddress = 0x1234567890123456789012345678901234567890n

const rpcEntry = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GOETH',
	primary: true,
	minimized: true,
}

function parseRpcResult(data: string) {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result
}

class TokenIdentificationRequestHandler {
	public rpcUrl = rpcEntry.httpsRpc

	public constructor(private readonly ethSimulateV1Result: unknown) {}

	public readonly jsonRpcRequest = async (rpcEntry: EthereumJsonRpcRequest) => {
		if (rpcEntry.method === 'eth_getCode') return '0x01'
		if (rpcEntry.method === 'eth_getBlockByNumber') return parseRpcResult(eth_getBlockByNumber_goerli_8443561_true)
		if (rpcEntry.method === 'eth_simulateV1') return this.ethSimulateV1Result
		throw new Error(`Unexpected RPC method ${ rpcEntry.method }`)
	}

	public readonly clearCache = () => undefined

	public readonly getChainId = async () => 5n
}

const createEthereum = (ethSimulateV1Result: unknown) => new EthereumClientService(
	new TokenIdentificationRequestHandler(ethSimulateV1Result),
	async () => undefined,
	async () => undefined,
	rpcEntry,
)

const createEthSimulateV1Result = (returnData: readonly `0x${ string }`[]) => [{
	number: '0x1',
	hash: `0x${ '1'.repeat(64) }`,
	timestamp: '0x1',
	gasLimit: '0x1c9c380',
	gasUsed: '0x0',
	baseFeePerGas: '0x1',
	calls: returnData.map((data) => ({
		status: '0x1',
		returnData: data,
		gasUsed: '0x0',
		logs: [],
	})),
}]

describe('token identification', () => {
	test('identifies valid ERC20 metadata and keeps decimals as bigint', async () => {
		const ethereum = createEthereum(createEthSimulateV1Result([
			'0x',
			'0x',
			'0x',
			encodeFunctionReturn(Erc20ABI, 'name', ['Example Token']),
			encodeFunctionReturn(Erc20ABI, 'symbol', ['EXT']),
			encodeFunctionReturn(Erc20ABI, 'decimals', [6n]),
			encodeFunctionReturn(Erc20ABI, 'totalSupply', [1000000n]),
		]))

		const identifiedAddress = await itentifyAddressViaOnChainInformation(ethereum, undefined, tokenAddress)

		assert.equal(identifiedAddress.type, 'ERC20')
		assert.equal(identifiedAddress.address, tokenAddress)
		if (identifiedAddress.type !== 'ERC20') throw new Error('Expected ERC20 token identification')
		assert.equal(identifiedAddress.name, 'Example Token')
		assert.equal(identifiedAddress.symbol, 'EXT')
		assert.equal(identifiedAddress.decimals, 6n)
	})

	test('treats empty successful probe return data as an unknown contract', async () => {
		const ethereum = createEthereum(createEthSimulateV1Result([
			'0x',
			'0x',
			'0x',
			'0x',
			'0x',
			'0x',
			'0x',
		]))

		const identifiedAddress = await itentifyAddressViaOnChainInformation(ethereum, undefined, tokenAddress)

		assert.deepEqual(identifiedAddress, {
			type: 'contract',
			address: tokenAddress,
		})
		assert.equal(addressString(identifiedAddress.address), '0x1234567890123456789012345678901234567890')
	})
})
