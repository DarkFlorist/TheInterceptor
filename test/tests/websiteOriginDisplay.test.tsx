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

	test('retains the compact host display outside approval UI', () => {
		const dom = installDomMock()
		try {
			render(h(WebsiteOriginText, { website }), dom.document.body)
			assert.doesNotMatch(dom.document.body.textContent, /https:\/\//)
			assert.match(dom.document.body.textContent, /example\.test:8443/)
		} finally {
			render(null, dom.document.body)
		}
	})
})
