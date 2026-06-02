import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { MockRequestHandler } from '../MockRequestHandler.js'

const requestHandler = new MockRequestHandler()

const rpcEntry = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc-goerli.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
}

const ethereum = new EthereumClientService(
	requestHandler,
	async () => undefined,
	async () => undefined,
	rpcEntry,
)

describe('getAddressMetaData', () => {
	test('contain USDC Coin', async () => {
		const metadata = await identifyAddress(ethereum, undefined, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, false)
		console.warn(metadata)
		assert.equal(metadata.name, 'USDC')
	})
})
