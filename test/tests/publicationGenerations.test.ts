import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createPublicationGenerations } from '../../app/ts/background/publicationGenerations.js'

test('publication generations supersede the same socket without invalidating another socket', () => {
	const publications = createPublicationGenerations<string>(true)
	const first = publications.begin('1:2')
	const other = publications.begin('1:3')
	const latest = publications.begin('1:2')
	assert.equal(first(), false)
	assert.equal(other(), true)
	assert.equal(latest(), true)
	assert.equal(publications.setEnabled(true), undefined)
	assert.equal(latest(), true, 'an idempotent preference write keeps the current publication')
})

test('socket retraction invalidates captured work and reports whether a tracked publication existed', () => {
	const publications = createPublicationGenerations<string>(true)
	const current = publications.begin('1:2')
	assert.equal(publications.retract('1:2'), true)
	assert.equal(current(), false)
	assert.equal(publications.retract('1:2'), false)
	assert.equal(publications.begin('1:2')(), true)
})

test('disable snapshots every tracked socket and old publications stay invalid after re-enable', () => {
	const publications = createPublicationGenerations<string>(true)
	const first = publications.begin('1:2')
	const second = publications.begin('2:3')
	assert.deepEqual(publications.setEnabled(false), new Set(['1:2', '2:3']))
	assert.equal(first(), false)
	assert.equal(second(), false)
	assert.deepEqual(publications.setEnabled(true), new Set())
	assert.equal(first(), false)
	assert.equal(second(), false)
	assert.equal(publications.begin('1:2')(), true)
})

test('unknown and known-disabled preferences cannot retain publication work', () => {
	const publications = createPublicationGenerations<string>()
	assert.equal(publications.getEnabled(), undefined)
	const unknown = publications.begin('1:2')
	assert.equal(unknown(), false)
	assert.deepEqual(publications.setEnabled(false), new Set(), 'the first disabled decision remains observable for scoped startup retractions')
	assert.equal(publications.getEnabled(), false)
	const disabled = publications.begin('1:2')
	assert.equal(disabled(), false)
	assert.deepEqual(publications.setEnabled(true), new Set())
	assert.equal(unknown(), false)
	assert.equal(disabled(), false)
})

test('independent capabilities never invalidate each other even when their socket keys match', () => {
	const sdk = createPublicationGenerations<string>(true)
	const http = createPublicationGenerations<string>(true)
	const sdkCurrent = sdk.begin('1:2')
	const httpCurrent = http.begin('1:2')
	http.setEnabled(false)
	assert.equal(sdkCurrent(), true)
	assert.equal(httpCurrent(), false)
})
