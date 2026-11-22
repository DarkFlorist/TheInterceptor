import * as assert from 'assert'
import { test } from 'bun:test'
import { getAccountNonceAfterTransactions } from '../../app/ts/simulation/accountNonce.js'

test('ordinary sender accounting needs neither authorizations nor a code lookup', async () => {
	assert.equal(await getAccountNonceAfterTransactions({
		address: 1n, chainId: 1n, initialNonce: 4n,
		transactions: [{ sender: 1n }, { sender: 2n }, { sender: undefined }, { sender: 1n }],
		getCode: async () => { throw new Error('Ordinary transactions must not read authority code') },
	}), 6n)
})
