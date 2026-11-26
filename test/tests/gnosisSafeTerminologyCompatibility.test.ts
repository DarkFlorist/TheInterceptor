import * as assert from 'assert'
import { test } from 'bun:test'
import { createGnosisSafeTx } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { createGnosisSafeMessageTypedData } from '../../app/ts/gnosisSafe/gnosisSafeMessage.js'
import { GnosisSafeStackExport } from '../../app/ts/types/gnosisSafeTypes.js'
import { createGnosisSafeAppsRequest } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'

test('Gnosis Safe terminology preserves external signing, SDK and exported-stack contracts', () => {
	const transaction = createGnosisSafeTx(1n, 1n, { to: 2n, value: 0n, input: new Uint8Array() }, 0n)
	assert.equal(transaction.primaryType, 'SafeTx')
	assert.ok(Object.prototype.hasOwnProperty.call(transaction.types, 'SafeTx'))
	assert.equal(Object.prototype.hasOwnProperty.call(transaction.types, 'GnosisSafeTx'), false)
	const message = createGnosisSafeMessageTypedData(1n, 1n, 'hello')
	assert.equal(message.primaryType, 'SafeMessage')
	assert.ok(Object.prototype.hasOwnProperty.call(message.types, 'SafeMessage'))
	assert.equal(Object.prototype.hasOwnProperty.call(message.types, 'GnosisSafeMessage'), false)
	assert.equal(createGnosisSafeAppsRequest('discovery', 'getSafeInfo').method, 'getSafeInfo')
	assert.equal(GnosisSafeStackExport.test({ name: 'Interceptor Safe Stack', version: '1.0.0', stacks: [] }), true)
})
