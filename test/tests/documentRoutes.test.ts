import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { prepareDocumentResponse } from '../benchmarks/documentRoutes.js'

test('document fixtures match exact URLs and leave unrelated or invalid requests untouched', () => {
	const routes = [{ url: 'https://fixture.test/page?mode=1', body: 'fixture' }]
	assert.equal(prepareDocumentResponse(routes, 'https://fixture.test/page'), undefined)
	assert.equal(prepareDocumentResponse(routes, 'https://fixture.test/page?mode=2'), undefined)
	assert.equal(prepareDocumentResponse(routes, undefined), undefined)
	assert.equal(prepareDocumentResponse(routes, { url: routes[0]?.url }), undefined)
	assert.equal(prepareDocumentResponse([], 'https://fixture.test/page?mode=1'), undefined)
	assert.ok(prepareDocumentResponse(routes, 'https://fixture.test/page?mode=1'))
})

test('document fixtures share the default HTML content type and preserve UTF-8 body bytes', () => {
	const body = '<p>Gnosis Safe ✓ — 日本語</p>'
	assert.deepEqual(prepareDocumentResponse([{ url: 'https://fixture.test/', body }], 'https://fixture.test/'), {
		statusCode: 200,
		headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
		bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
	})
})

test('document fixture headers override the default and the first matching route owns the response', () => {
	const routes = [
		{ url: 'https://fixture.test/data', body: '{"current":true}', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
		{ url: 'https://fixture.test/data', body: 'decoy' },
	]
	const response = prepareDocumentResponse(routes, 'https://fixture.test/data')
	assert.deepEqual(response?.headers, [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }])
	assert.equal(response?.bodyBase64, Buffer.from('{"current":true}').toString('base64'))
	assert.equal(routes[0]?.headers?.['Content-Type'], 'application/json')
	for (const name of ['content-type', 'CONTENT-TYPE']) {
		const overridden = prepareDocumentResponse([{ url: 'https://fixture.test/', body: '', headers: { [name]: 'application/json' } }], 'https://fixture.test/')
		assert.deepEqual(overridden?.headers, [{ name, value: 'application/json' }], 'HTTP header overrides are case-insensitive')
	}
})
