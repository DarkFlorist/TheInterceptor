import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeSignatureRequirementLabel } from '../../app/ts/components/simulationExplaining/customExplainers/GnosisSafeVisualizer.js'
import type { SafeSignatureRequirement } from '../../app/ts/types/safeTypes.js'
import { installDomMock } from './domMock.js'

const OTHER_OWNERS_NOTE = 'Other owners must also sign before this can execute'

const renderLabel = async (requirement: SafeSignatureRequirement | undefined) => {
	const dom = installDomMock()
	await act(() => { render(h(SafeSignatureRequirementLabel, { requirement }), dom.document.body) })
	const text = dom.document.body.textContent ?? ''
	dom.restore()
	return text
}

describe('Safe signature requirement label', () => {
	test('a 1 of 1 Safe the user owns shows the requirement without the note', async () => {
		const text = await renderLabel({ threshold: 1n, ownerCount: 1n, userOwnerCount: 1n })
		assert.equal(text.includes('Needs 1 of 1 owner signatures'), true)
		assert.equal(text.includes(OTHER_OWNERS_NOTE), false)
	})

	test('a 2 of 3 Safe with the user as one owner notes that other owners must sign', async () => {
		const text = await renderLabel({ threshold: 2n, ownerCount: 3n, userOwnerCount: 1n })
		assert.equal(text.includes('Needs 2 of 3 owner signatures'), true)
		assert.equal(text.includes(OTHER_OWNERS_NOTE), true)
	})

	test('a 2 of 3 Safe with two of the user\'s accounts as owners needs no other owner', async () => {
		assert.equal((await renderLabel({ threshold: 2n, ownerCount: 3n, userOwnerCount: 2n })).includes(OTHER_OWNERS_NOTE), false)
	})

	test('a failed owner read shows nothing', async () => {
		assert.equal(await renderLabel(undefined), '')
	})
})
