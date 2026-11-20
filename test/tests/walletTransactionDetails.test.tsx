import * as assert from 'node:assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { WalletTransactionDetails } from '../../app/ts/components/subcomponents/WalletTransactionDetails.js'
import { installDomMock } from './domMock.js'

for (const fields of [
	{ type: '0x0', gasPrice: '0x2540be400' },
	{ type: '0x1', gasPrice: '0x2540be400', accessList: [] },
	{ type: '0x2', maxFeePerGas: '0x4a817c800', maxPriorityFeePerGas: '0x77359400' },
] as const) test(`wallet fee review shows actual ${ fields.type } fees instead of the zero-fee preview`, async () => {
	const dom = installDomMock()
	try {
		const request = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ ...fields, gas: '0x493e0', from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002' }] })
		await act(() => { render(h(WalletTransactionDetails, { request }), dom.document.body) })
		const text = dom.document.body.textContent
		assert.ok(text.includes('Wallet execution fees'))
		assert.ok(text.includes('Gas limit300000'))
		if ('gasPrice' in fields) assert.ok(text.includes('Gas Price10 nanoeth/gas'))
		else {
			assert.ok(text.includes('Max Fee Per Gas20 nanoeth/gas'))
			assert.ok(text.includes('Max Priority Fee Per Gas2 nanoeth/gas'))
		}
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})

test('wallet fee review leaves omitted gas and fees visibly wallet-selected', async () => {
	const dom = installDomMock()
	try {
		const request = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002' }] })
		await act(() => { render(h(WalletTransactionDetails, { request }), dom.document.body) })
		const text = dom.document.body.textContent
		assert.ok(text.includes('Transaction typeSelected by your wallet'))
		assert.ok(text.includes('Gas limitSelected by your wallet'))
		assert.ok(text.includes('Max Fee Per GasSelected by your wallet'))
		assert.ok(text.includes('Max Priority Fee Per GasSelected by your wallet'))
		assert.equal(text.includes('0 nanoeth/gas'), false)
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})
