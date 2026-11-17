import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeExecutionSimulationNotice } from '../../app/ts/components/simulationExplaining/Transactions.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { installDomMock } from './domMock.js'

const safeAddress = 0x1111111111111111111111111111111111111111n
const recipientAddress = 0x2222222222222222222222222222222222222222n
const safeTx = createSafeTx(1n, safeAddress, { to: recipientAddress, value: 1n, input: new Uint8Array() }, 5n)

type NoticeTransaction = Parameters<typeof SafeExecutionSimulationNotice>[0]['transaction']

const renderNoticeText = async (transaction: NoticeTransaction) => {
	const dom = installDomMock()
	await act(() => {
		render(h(SafeExecutionSimulationNotice, { transaction }), dom.document.body)
	})
	return dom.document.body.textContent ?? ''
}

describe('SafeExecutionSimulationNotice', () => {
	test('labels a Safe proposal and a simulation-mode Safe execution alike, and nothing else', async () => {
		const proposal: NoticeTransaction = { simulationOptions: { requiredChainId: 1n }, safeTransaction: { safeTx, safeTxHash: BigInt(getSafeTxHash(safeTx)), created: new Date(0), websiteOrigin: 'https://example.com', transactionIdentifier: 1n, signatures: [] } }
		const simulationModeExecution: NoticeTransaction = { simulationOptions: { requiredChainId: 1n, executeThroughSafe: true } }
		for (const transaction of [proposal, simulationModeExecution]) {
			const text = await renderNoticeText(transaction)
			assert.ok(text.includes('Gnosis Safe execution'))
			assert.ok(text.includes('an executor account calls the Safe\'s execTransaction and pays the network fees'))
		}
		assert.equal(await renderNoticeText({ simulationOptions: { requiredChainId: 1n } }), '')
	})
})
