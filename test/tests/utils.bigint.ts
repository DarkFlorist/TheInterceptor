import { bigintToRoundedPrettyDecimalString } from '../../app/ts/utils/bigint.js'
import { describe, runIfRoot, should, run } from '../micro-should.js'
import * as assert from 'assert'

export async function main() {
	describe('utils.bigint', () => {
		should('display 1 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 18n, 18n, 4), '1'))
		should('display 0.2 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(2n * 10n ** 17n, 18n, 4), '0.2'))
		should('display 0.00000001 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 10n, 18n, 4), '0.00000001'))
		should('display 100M ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(10n ** 26n, 18n, 4), '100M'))
		should('display 2.346k ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(234567n * 10n ** 16n, 18n, 4), '2.346k'))
		should('display -2.346k ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(-234567n * 10n ** 16n, 18n, 4), '-2.346k'))
		should('display -0.2346 ETH', () => assert.equal(bigintToRoundedPrettyDecimalString(-234567n * 10n ** 12n, 18n, 4), '-0.2346'))
	})
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
