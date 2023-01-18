import { getAddressMetaData } from '../../app/ts/background/metadataUtils.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'

export async function main() {
	describe('getAddressMetaData', () => {
		should('contain USDC Coin', () => {
			const metadata = getAddressMetaData(0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, undefined)
			assert.equal(metadata.name, 'USD Coin')
		})
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
