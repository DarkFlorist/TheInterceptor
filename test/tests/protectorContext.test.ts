import { test } from 'bun:test'
import * as assert from 'assert'
import { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import type { ProtectorContext } from '../../app/ts/simulation/protectorTypes.js'
import { runProtectorsForTransaction } from '../../app/ts/simulation/protectorRunner.js'
import { eoaCalldata } from '../../app/ts/simulation/protectors/eoaCalldata.js'
import { feeOops } from '../../app/ts/simulation/protectors/feeOops.js'

const transaction = EthereumUnsignedTransaction.parse({
	type: undefined, from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002',
	nonce: '0x0', gasPrice: '0xa', gas: '0x5208', value: '0x0', input: '0x', chainId: '0x1',
})
const unexpectedRead = async (): Promise<never> => { throw new Error('Unexpected dependency read') }
const context: ProtectorContext = {
	connectedChainId: 1n,
	chainReads: { readCode: unexpectedRead, readGasPrice: async () => 2n },
	identify: unexpectedRead,
	eventsPromise: Promise.resolve([]),
}

test('the full protector runner accepts injected dependencies without client or storage setup', async () => {
	assert.deepEqual(await runProtectorsForTransaction(transaction, context), { quarantine: false, quarantineReasons: [] })
	const result = await runProtectorsForTransaction(transaction, { ...context, connectedChainId: 2n })
	assert.equal(result.quarantine, true)
	assert.equal(result.quarantineReasons.length, 1)
	assert.match(result.quarantineReasons[0] ?? '', /different chain/)
})

test('legacy fee checks use the injected gas price and preserve the threshold', async () => {
	assert.equal(await feeOops(transaction, context), undefined)
	assert.match(await feeOops(transaction, { chainReads: { readCode: unexpectedRead, readGasPrice: async () => 1n } }) ?? '', /outrageous fee/)
})

test('calldata checks distinguish absent and unverified code using injected reads', async () => {
	const withCalldata = { ...transaction, input: new Uint8Array([1]) }
	assert.equal(await eoaCalldata(withCalldata, { chainReads: { readCode: async () => 'present', readGasPrice: unexpectedRead }, identify: unexpectedRead }), undefined)
	assert.match(await eoaCalldata(withCalldata, { chainReads: { readCode: async () => 'absent', readGasPrice: unexpectedRead }, identify: unexpectedRead }) ?? '', /Externally Owned Account/)
	assert.match(await eoaCalldata(withCalldata, { chainReads: { readCode: async () => 'unverified', readGasPrice: unexpectedRead }, identify: async (address) => ({ address, name: 'Recipient', type: 'contact', entrySource: 'OnChain', chainId: 1n }) }) ?? '', /Failed to verify/)
})
