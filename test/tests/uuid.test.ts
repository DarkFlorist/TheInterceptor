import * as assert from 'assert'
import { test } from 'bun:test'
import { generateUuidV4, isUuid } from '../../app/ts/utils/uuid.js'
import { isEip6963ProviderUuid } from '../../app/ts/utils/eip6963ProviderInfo.js'

test('bridge and EIP-6963 UUIDs share a primitive validator without publishing private inputs to RegExp statics', () => {
	const generated = generateUuidV4()
	assert.equal(isUuid(generated), true)
	assert.equal(isEip6963ProviderUuid(generated), true)
	assert.equal(generated[14], '4')
	assert.equal(isUuid('11111111-1111-5111-8111-111111111111'), true)
	assert.equal(isEip6963ProviderUuid('11111111-1111-5111-8111-111111111111'), false)
	for (const value of [undefined, {}, '', '11111111-1111-4111-7111-111111111111', '11111111-1111-6111-8111-111111111111']) assert.equal(isUuid(value), false)
	const baseline = /baseline/
	baseline.test('baseline')
	isUuid(generated)
	isEip6963ProviderUuid(generated)
	assert.equal(RegExp.lastMatch, 'baseline')
})
