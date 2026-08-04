import * as assert from 'assert'
import { test } from 'bun:test'
import { collectSplitCommentDiagnostics, fixSplitProseComments } from '../../scripts/check-single-line-comments.mts'

test('single-line comment lint reports and fixes wrapped prose', () => {
	const sourceText = [
		'\t// maxUsedGas is a widely implemented extension, but it is not yet',
		'\t// required by the specification. Discover a working limit by rerunning',
		'\t// the exact call.',
		'\tcall()',
		'',
	].join('\n')

	assert.deepEqual(collectSplitCommentDiagnostics('fixture.ts', sourceText), [
		{ file: 'fixture.ts', line: 2, column: 2 },
		{ file: 'fixture.ts', line: 3, column: 2 },
	])
	assert.equal(fixSplitProseComments(sourceText), [
		'\t// maxUsedGas is a widely implemented extension, but it is not yet required by the specification. Discover a working limit by rerunning the exact call.',
		'\tcall()',
		'',
	].join('\n'))
})

test('single-line comment lint preserves structured comments and commented code', () => {
	const sourceText = [
		'// Explanation for the reference below.',
		'// https://example.com/reference',
		'// original: https://example.com/original',
		'// source: https://example.com/source',
		'// see: https://example.com/security',
		'// licenses LICENSE_first.md & LICENSE_second.md',
		'// created: 2026-08-04',
		'// Copyright (c) Example.',
		'// SPDX-License-Identifier: MIT',
		'// const disabled = true',
		'// return disabled',
		'',
	].join('\n')

	assert.deepEqual(collectSplitCommentDiagnostics('fixture.ts', sourceText), [])
	assert.equal(fixSplitProseComments(sourceText), sourceText)
})

test('single-line comment lint preserves adjacent provenance labels without colons', () => {
	const sourceText = [
		'// licenses LICENSE_first.md',
		'// licenses LICENSE_second.md',
		'// created 2026-08-04',
		'// compressed data payload',
		'',
	].join('\n')

	assert.deepEqual(collectSplitCommentDiagnostics('fixture.ts', sourceText), [])
	assert.equal(fixSplitProseComments(sourceText), sourceText)
})

test('single-line comment lint preserves adjacent commented-out statements', () => {
	const sourceText = [
		'// return disabled',
		'// throw makeError()',
		'// if (disabled) {',
		'// else {',
		'// for (const value of values) {',
		'// doThing()',
		'',
	].join('\n')

	assert.deepEqual(collectSplitCommentDiagnostics('fixture.ts', sourceText), [])
	assert.equal(fixSplitProseComments(sourceText), sourceText)
})

test('single-line comment lint recognizes prose that resembles code syntax', () => {
	const sourceText = [
		'// if user access is enabled, refresh the account;',
		'// otherwise keep the existing selection.',
		'// return values from this endpoint may be incomplete',
		'// when the node is still syncing.',
		'',
	].join('\n')

	assert.equal(collectSplitCommentDiagnostics('fixture.ts', sourceText).length, 3)
	assert.equal(fixSplitProseComments(sourceText), [
		'// if user access is enabled, refresh the account; otherwise keep the existing selection. return values from this endpoint may be incomplete when the node is still syncing.',
		'',
	].join('\n'))
})

test('single-line comment fixer rejoins a word split at a hyphen', () => {
	const sourceText = '// State and state-\n// override blocks use the same RPC handler.\n'
	assert.equal(fixSplitProseComments(sourceText), '// State and state-override blocks use the same RPC handler.\n')
})
