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

const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)

describe('getAddressMetaData', () => {
	test('contain USDC Coin', async () => {
		const metadata = await identifyAddress(ethereum, undefined, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, false)
		console.warn(metadata)
		assert.equal(metadata.name, 'USDC')
	})

	test('recognizes a bundled token that is only listed under its checksummed address', async () => {
		const compoundPaxDollar = 0x041171993284df560249b57358f931d9eb7b925dn
		const metadata = await identifyAddress(ethereum, undefined, compoundPaxDollar, false)
		assert.deepEqual(metadata, {
			name: 'Compound Pax Dollar',
			symbol: 'cUSDP',
			decimals: 8n,
			logoUri: '../vendor/@darkflorist/address-metadata/images/contracts/compound.png',
			address: compoundPaxDollar,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			chainId: rpcEntry.chainId,
		})
	})

	test('prefers the lowercase bundled entry when a token is listed under both address forms', async () => {
		const aaveDai = 0x028171bca77440897b824ca71d1c56cac55b68a3n
		const metadata = await identifyAddress(ethereum, undefined, aaveDai, false)
		assert.equal(metadata.type, 'ERC20')
		assert.equal(metadata.entrySource, 'DarkFloristMetadata')
		assert.equal(metadata.name, 'Aave DAI')
		assert.equal('symbol' in metadata ? metadata.symbol : undefined, 'ADAI')
		assert.equal(metadata.logoUri, '../vendor/@darkflorist/address-metadata/images/tokens/0x028171bca77440897b824ca71d1c56cac55b68a3.png')
	})

	test('keeps already recognized lowercase-keyed tokens unchanged', async () => {
		const weth = await identifyAddress(ethereum, undefined, 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n, false)
		assert.equal(weth.entrySource, 'DarkFloristMetadata')
		assert.equal(weth.name, 'WETH')
		assert.equal(weth.logoUri, '../vendor/@darkflorist/address-metadata/images/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png')
		const usdc = await identifyAddress(ethereum, undefined, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, false)
		assert.equal(usdc.entrySource, 'DarkFloristMetadata')
		assert.equal('symbol' in usdc ? usdc.symbol : undefined, 'USDC')
	})
})
