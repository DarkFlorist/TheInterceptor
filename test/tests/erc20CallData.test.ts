import { test } from 'bun:test'
import * as assert from 'node:assert/strict'
import { balanceOfData, allowanceData } from '../../app/inpage/ts/erc20CallData.js'

test('ERC20 calls normalize and encode zero, mixed-case and full address words', () => {
	for (const owner of ['0x' + '00'.repeat(20), '0x' + 'aB'.repeat(20), '0x' + 'ff'.repeat(20)]) {
		const word = '0'.repeat(24) + owner.slice(2).toLowerCase()
		assert.equal(balanceOfData(owner), '0x70a08231' + word)
		assert.equal(allowanceData(owner, owner), '0xdd62ed3e' + word + word)
	}
	for (const invalid of ['0x1', '0x' + 'gg'.repeat(20), '0x' + 'aa'.repeat(21)]) assert.throws(() => balanceOfData(invalid))
})
