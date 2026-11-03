import * as assert from 'assert'
import { describe, test } from 'bun:test'

const css = await Bun.file(new URL('../../app/css/interceptor-pages.css', import.meta.url)).text()

function getRuleBody(selector: string) {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = css.match(new RegExp(`${ escapedSelector }\\s*\\{([^}]*)\\}`))
	assert.notEqual(match, null, `Missing CSS rule for ${ selector }`)
	return match?.[1] ?? ''
}

describe('management view CSS', () => {
	test('management navigation has a local stacking context beneath the body portal', () => {
		const managementPage = getRuleBody('.management-page')
		const managementHeader = getRuleBody('.management-header')
		const websiteDetails = getRuleBody('.access-details')
		assert.match(managementPage, /isolation:\s*isolate;/)
		assert.match(managementHeader, /z-index:\s*\d+;/)
		assert.match(websiteDetails, /z-index:\s*\d+;/)
	})
})
