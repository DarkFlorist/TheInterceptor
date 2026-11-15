import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { MockRequestHandler } from '../MockRequestHandler.js'

const requestHandler = new MockRequestHandler()
const USDC_MAINNET_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n

const baseRpcEntry = {
	httpsRpc: requestHandler.rpcUrl,
	primary: true,
	minimized: true,
}

const mainnetEthereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
	...baseRpcEntry,
	name: 'Ethereum Mainnet',
	chainId: 1n,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
})

const goerliEthereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, {
	...baseRpcEntry,
	name: 'Goerli',
	chainId: 5n,
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
})

describe('getAddressMetaData', () => {
	test('identifies USDC from bundled metadata on Ethereum mainnet', async () => {
		const metadata = await identifyAddress(mainnetEthereum, undefined, USDC_MAINNET_ADDRESS, false)
		assert.equal(metadata.type, 'ERC20')
		assert.equal(metadata.name, 'USDC')
		assert.equal(metadata.entrySource, 'DarkFloristMetadata')
		assert.equal(metadata.chainId, 1n)
	})

	test('does not apply bundled mainnet metadata to the same address on another chain', async () => {
		const metadata = await identifyAddress(goerliEthereum, undefined, USDC_MAINNET_ADDRESS, false)
		assert.notEqual(metadata.entrySource, 'DarkFloristMetadata')
		assert.notEqual(metadata.name, 'USDC')
		assert.equal(metadata.type, 'contact')
		assert.equal(metadata.entrySource, 'OnChain')
		assert.equal(metadata.chainId, 5n)
	})
})
