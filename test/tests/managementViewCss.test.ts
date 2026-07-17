import * as assert from 'assert'
import { describe, test } from 'bun:test'

const css = await Bun.file(new URL('../../app/css/interceptor.css', import.meta.url)).text()

function getRuleBody(selector: string) {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = css.match(new RegExp(`${ escapedSelector }\\s*\\{([^}]*)\\}`))
	assert.notEqual(match, null, `Missing CSS rule for ${ selector }`)
	return match?.[1] ?? ''
}

describe('management view CSS', () => {
	test('website details render above the sticky management navigation', () => {
		const managementHeader = getRuleBody('.management-header')
		const websiteDetails = getRuleBody('.access-details')
		const managementHeaderZIndex = Number(managementHeader.match(/z-index:\s*(\d+)/)?.[1])
		const websiteDetailsZIndex = Number(websiteDetails.match(/z-index:\s*(\d+)/)?.[1])

		assert.equal(Number.isFinite(managementHeaderZIndex), true)
		assert.equal(Number.isFinite(websiteDetailsZIndex), true)
		assert.equal(websiteDetailsZIndex > managementHeaderZIndex, true)
	})
})
