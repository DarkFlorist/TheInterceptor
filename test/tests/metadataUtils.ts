import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'
import { MockRequestHandler } from '../MockRequestHandler.js'

export async function main() {
	const ethereum = new EthereumClientService(new MockRequestHandler(), () => {}, () => {})
	describe('getAddressMetaData', () => {
		should('contain USDC Coin', async () => {
			const metadata = await identifyAddress(ethereum, { activeAddresses: [], contacts: [] }, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, false)
			console.log(metadata)
			assert.equal(metadata.name, 'USD Coin')
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
