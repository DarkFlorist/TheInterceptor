import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'
import { MockRequestHandler } from '../MockRequestHandler.js'

export async function main() {
	const ethereum = new EthereumClientService(new MockRequestHandler(), async () => {}, async () => {})
	describe('getAddressMetaData', () => {
		should('contain USDC Coin', async () => {
			const metadata = await identifyAddress(ethereum, undefined, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, false)
			// biome-ignore lint/suspicious/noConsoleLog: test runner logs
			console.log(metadata)
			assert.equal(metadata.name, 'USDC')
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
