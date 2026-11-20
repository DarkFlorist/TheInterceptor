import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { WebsiteOriginText } from '../../app/ts/components/subcomponents/address.js'
import { installDomMock } from './domMock.js'

const website = {
	websiteOrigin: 'https://example.test:8443',
	icon: undefined,
	title: 'Example test site',
}

describe('website origin display', () => {
	test('shows the complete scheme-bound origin when approval UI requests it', () => {
		const dom = installDomMock()
		try {
			render(h(WebsiteOriginText, { website, displayFullOrigin: true }), dom.document.body)
			assert.match(dom.document.body.textContent, /https:\/\/example\.test:8443/)
		} finally {
			render(null, dom.document.body)
		}
	})

	test.each(['https://example.test:8443', 'example.test:8443'])('retains the compact host display for %s outside approval UI', (websiteOrigin) => {
		const dom = installDomMock()
		try {
			render(h(WebsiteOriginText, { website: { ...website, websiteOrigin } }), dom.document.body)
			assert.doesNotMatch(dom.document.body.textContent, /https:\/\//)
			assert.match(dom.document.body.textContent, /example\.test:8443/)
		} finally {
			render(null, dom.document.body)
		}
	})
})
