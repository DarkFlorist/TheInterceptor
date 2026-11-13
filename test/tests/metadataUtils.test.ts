import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { MockRequestHandler } from '../MockRequestHandler.js'

const requestHandler = new MockRequestHandler()
const USDC_MAINNET_ADDRESS = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n
const COMPOUND_PAX_DOLLAR_CHECKSUMMED_ONLY_ADDRESS = 0x041171993284df560249b57358f931d9eb7b925dn

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

	test('identifies a bundled token stored only under its checksummed address', async () => {
		const metadata = await identifyAddress(mainnetEthereum, undefined, COMPOUND_PAX_DOLLAR_CHECKSUMMED_ONLY_ADDRESS, false)
		assert.deepStrictEqual(metadata, {
			name: 'Compound Pax Dollar',
			symbol: 'cUSDP',
			decimals: 8n,
			logoUri: '../vendor/@darkflorist/address-metadata/images/contracts/compound.png',
			address: COMPOUND_PAX_DOLLAR_CHECKSUMMED_ONLY_ADDRESS,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			chainId: 1n,
		})
	})

	test('does not apply a bundled token stored only under its checksummed address to another chain', async () => {
		const metadata = await identifyAddress(goerliEthereum, undefined, COMPOUND_PAX_DOLLAR_CHECKSUMMED_ONLY_ADDRESS, false)
		assert.notEqual(metadata.name, 'Compound Pax Dollar')
		assert.equal(metadata.type, 'contact')
		assert.equal(metadata.entrySource, 'OnChain')
		assert.equal(metadata.chainId, 5n)
	})

	test('keeps identifying a token stored under both casings by its lower case entry', async () => {
		const metadata = await identifyAddress(mainnetEthereum, undefined, 0x028171bca77440897b824ca71d1c56cac55b68a3n, false)
		assert.deepStrictEqual(metadata, {
			name: 'Aave DAI',
			symbol: 'ADAI',
			decimals: 18n,
			logoUri: '../vendor/@darkflorist/address-metadata/images/tokens/0x028171bca77440897b824ca71d1c56cac55b68a3.png',
			address: 0x028171bca77440897b824ca71d1c56cac55b68a3n,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			chainId: 1n,
		})
	})
})
