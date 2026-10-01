import * as assert from 'assert'
import { test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { getClassicInpageSource } from '../../scripts/inline-inpage-document-start.mts'

test('MV2 document-start embeds a classic provider with the shared SDK protocol resolved', async () => {
	const source = await getClassicInpageSource('app/inpage/ts/inpage.ts')
	// Executing the same embedded text must reach provider setup, rather than failing on an import statement or missing shared bindings.
	let setupReached = false
	const providerWindow = new Proxy({}, { get: (_target, property) => {
		if (property === 'addEventListener') return () => { setupReached = true; throw new Error('Fixture reached provider setup') }
		return undefined
	} })
	assert.throws(() => runInNewContext(source, { window: providerWindow }), /Fixture reached provider setup/)
	assert.equal(setupReached, true)
	assert.doesNotMatch(source, /^import\s/m)
})
