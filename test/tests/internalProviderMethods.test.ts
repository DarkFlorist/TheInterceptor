import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { INTERNAL_PROVIDER_METHODS } from '../../app/ts/utils/internalProviderMethods.js'
import { GENERATED_INTERNAL_PROVIDER_METHODS } from '../../app/ts/utils/internalProviderMethods.generated.js'

describe('internal provider method definitions', () => {
	test('generated inpage allowlist stays aligned with the shared background definition', () => {
		assert.deepEqual([...GENERATED_INTERNAL_PROVIDER_METHODS], [...INTERNAL_PROVIDER_METHODS])
	})
})
