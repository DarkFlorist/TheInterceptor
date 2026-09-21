import * as assert from 'assert'
import { test } from 'bun:test'
import { collectForbiddenUnitDiagnostics } from '../../scripts/check-si-units.mts'

const reportedTexts = (sourceText: string) => collectForbiddenUnitDiagnostics('fixture.tsx', sourceText).map((diagnostic) => diagnostic.text)

test('SI units lint reports wei and gwei in strings, templates, JSX text, and identifiers', () => {
	const sourceText = [
		'const a = \'value in wei\'',
		'const b = `${ a } Wei`',
		'const c = `${ a } gwei ${ b } more`',
		'const maxFeePerGasWei = 1n',
		'const fee_in_gwei = 2n',
		'const weiValue = 3n',
		'const WEI_PER_ETH = 4n',
		'const toWEI = 5n',
		'const wei2eth = 6n',
		'class Fees { #wei = 7n }',
		'function jsx() { return <p>paid in wei</p> }',
		'',
	].join('\n')
	assert.deepEqual(reportedTexts(sourceText), [
		'\'value in wei\'',
		'} Wei`',
		'} gwei ${',
		'maxFeePerGasWei',
		'fee_in_gwei',
		'weiValue',
		'WEI_PER_ETH',
		'toWEI',
		'wei2eth',
		'#wei',
		'paid in wei',
	])
})

test('SI units lint reports comments in every position exactly once', () => {
	const sourceText = [
		'// leading wei',
		'const a = 1n // trailing gwei',
		'/* block wei */',
		'function f() { // after brace wei',
		'\treturn f( // after paren wei',
		'\t\t[ /* in array wei */ ],',
		'\t)',
		'}',
		'switch (a) { case 1n: // after case wei',
		'\tbreak',
		'}',
		'function jsx() { return <p>{/* jsx wei */}</p> }',
		'/** @param wei amount */',
		'function documented(wei: bigint) { return wei }',
		'/** @param feeWei stale name */',
		'function renamed(feeAttoeth: bigint) { return feeAttoeth }',
		'',
	].join('\n')
	assert.deepEqual(reportedTexts(sourceText), [
		'// leading wei',
		'// trailing gwei',
		'/* block wei */',
		'// after brace wei',
		'// after paren wei',
		'/* in array wei */',
		'// after case wei',
		'/* jsx wei */',
		'/** @param wei amount */',
		'wei',
		'wei',
		'feeWei',
	])
})

test('SI units lint ignores similar words, SI units, and comment markers inside strings', () => {
	const sourceText = [
		'const weight = \'weird weight\'',
		'const Weimar = \'GWEIS\'',
		'const fee = `${ weight } nanoeth/gas`',
		'const attoeth = \'attoeth\'',
		'const open = \'/*\'',
		'const wide = 8n',
		'const close = \'*/\'',
		'',
	].join('\n')
	assert.deepEqual(reportedTexts(sourceText), [])
})
