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

	test('identifies a bundled token stored only under its checksummed address', async () => {
		const metadata = await identifyAddress(ethereum, undefined, 0x041171993284df560249b57358f931d9eb7b925dn, false)
		assert.deepStrictEqual(metadata, {
			name: 'Compound Pax Dollar',
			symbol: 'cUSDP',
			decimals: 8n,
			logoUri: '../vendor/@darkflorist/address-metadata/images/contracts/compound.png',
			address: 0x041171993284df560249b57358f931d9eb7b925dn,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			chainId: 5n,
		})
	})

	test('keeps identifying a token stored under both casings by its lower case entry', async () => {
		const metadata = await identifyAddress(ethereum, undefined, 0x028171bca77440897b824ca71d1c56cac55b68a3n, false)
		assert.deepStrictEqual(metadata, {
			name: 'Aave DAI',
			symbol: 'ADAI',
			decimals: 18n,
			logoUri: '../vendor/@darkflorist/address-metadata/images/tokens/0x028171bca77440897b824ca71d1c56cac55b68a3.png',
			address: 0x028171bca77440897b824ca71d1c56cac55b68a3n,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			chainId: 5n,
		})
	})
})
