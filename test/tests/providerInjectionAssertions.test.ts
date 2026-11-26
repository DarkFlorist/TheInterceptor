import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'
import { getProviderInjectionFailure, type InjectionObservations } from '../benchmarks/providerInjectionAssertions.js'

const inline = { external: false, src: '', providerDefined: true }
const featurePath = 'inpage/js/fixture-feature.js'
const scripts = ['inpage/js/fixture-provider.js', featurePath]
const observe = (addedScripts: InjectionObservations['addedScripts'], cspViolations = 0) => ({ providerArrived: true, observations: { providerAtFirstPageScript: false, addedScripts, cspViolations } })

test('all configured inline scripts pass without being mistaken for a URL fallback', () => {
	const observed = observe(scripts.map(() => inline))
	assert.equal(getProviderInjectionFailure(observed, false, scripts), undefined)
	assert.match(getProviderInjectionFailure(observe([inline]), false, scripts) ?? '', /expected .* inline/)
	assert.match(getProviderInjectionFailure(observe([...observed.observations.addedScripts, inline]), false, scripts) ?? '', /expected .* inline/)
	assert.match(getProviderInjectionFailure(observe(scripts.map(() => ({ ...inline, providerDefined: false }))), false, scripts) ?? '', /not defined synchronously/)
})

test('an actual external script remains a failure when inline injection was allowed', () => {
	assert.match(getProviderInjectionFailure(observe([inline, { ...inline, external: true, src: 'moz-extension://fixture/extra.js' }]), false, scripts) ?? '', /URL fallback ran/)
})

for (const mode of [false, true]) test(`strict CSP requires all ordered provider/feature fallbacks in compatibility mode ${ mode }`, () => {
	const provider = getPageWorldScriptPaths(mode)[0]
	assert.ok(provider)
	const paths = [provider, featurePath]
	const added = paths.flatMap((path) => [
		{ ...inline, providerDefined: false },
		{ external: true, src: `moz-extension://fixture/${ path }`, providerDefined: false },
	])
	assert.equal(getProviderInjectionFailure(observe(added, paths.length), true, paths), undefined)
	assert.match(getProviderInjectionFailure(observe(added.slice(0, 2), paths.length), true, paths) ?? '', /not every blocked inline/)
	assert.match(getProviderInjectionFailure(observe(added, 0), true, paths) ?? '', /did not block every inline/)
	const reversed = [...added.slice(2), ...added.slice(0, 2)]
	assert.match(getProviderInjectionFailure(observe(reversed, paths.length), true, paths) ?? '', /provider-before-feature order/)
	const wrongOrigin = added.map((script) => ({ ...script, src: script.src.replace('moz-extension:', 'https:') }))
	assert.match(getProviderInjectionFailure(observe(wrongOrigin, paths.length), true, paths) ?? '', /provider-before-feature order/)
})

test('early native injection and missing-provider failures remain distinct', () => {
	assert.equal(getProviderInjectionFailure({ providerArrived: true, observations: { providerAtFirstPageScript: true, addedScripts: [], cspViolations: 0 } }, true), undefined)
	assert.equal(getProviderInjectionFailure({ providerArrived: false, observations: undefined }, false), 'the provider never arrived')
	assert.equal(getProviderInjectionFailure({ providerArrived: true, observations: undefined }, false), 'the page did not record its observations')
})


test('single-script providers remain valid when no feature entrypoints are configured', () => {
	const paths = ['inpage/js/fixture-provider.js']
	assert.equal(getProviderInjectionFailure(observe([inline]), false, paths), undefined)
	assert.equal(getProviderInjectionFailure(observe([{ ...inline, providerDefined: false }, { external: true, src: `moz-extension://fixture/${ paths[0] }`, providerDefined: false }], 1), true, paths), undefined)
})


test('CSP fallback checks exact extension paths rather than suffixes', () => {
	const paths = ['inpage/js/fixture-provider.js']
	for (const src of ['moz-extension://fixture/unexpected-prefix/inpage/js/fixture-provider.js', 'https://fixture/inpage/js/fixture-provider.js', 'not-an-absolute-url']) {
		const result = observe([{ ...inline, providerDefined: false }, { external: true, src, providerDefined: false }], 1)
		assert.match(getProviderInjectionFailure(result, true, paths) ?? '', /provider-before-feature order/)
	}
})
