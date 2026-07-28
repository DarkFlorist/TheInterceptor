import * as assert from 'assert'
import { test } from 'bun:test'
import { signerProviderOptionLabel } from '../../app/ts/components/pages/Home.js'

test('signer provider choices visibly disambiguate identical wallet identities by UUID', () => {
	const firstProvider = {
		name: 'Example Wallet',
		rdns: 'com.example.wallet',
		uuid: '11111111-1111-4111-8111-111111111111',
	}
	const secondProvider = {
		...firstProvider,
		uuid: '22222222-2222-4222-8222-222222222222',
	}

	const firstLabel = signerProviderOptionLabel(firstProvider)
	const secondLabel = signerProviderOptionLabel(secondProvider)
	assert.notEqual(firstLabel, secondLabel)
	assert.equal(firstLabel.includes(firstProvider.uuid), true)
	assert.equal(secondLabel.includes(secondProvider.uuid), true)
})

test('signer provider selector uses the themed full-width Bulma control structure', async () => {
	const [homeSource, css] = await Promise.all([
		Bun.file('app/ts/components/pages/Home.tsx').text(),
		Bun.file('app/css/interceptor.css').text(),
	])

	assert.match(homeSource, /<label class = 'signer-provider-selector-label' for = 'signer-provider-selector'>/)
	assert.match(homeSource, /<div class = 'select is-fullwidth signer-provider-selector-control'>\s*<select/)
	assert.doesNotMatch(homeSource, /<select[\s\S]*?class = 'select'/)
	assert.match(css, /\.signer-provider-selector-label\s*\{[\s\S]*?color:\s*var\(--text-color\)/)
	assert.match(css, /\.signer-provider-selector-control,\s*\.signer-provider-selector-control select\s*\{[\s\S]*?min-width:\s*0[\s\S]*?width:\s*100%/)
	assert.match(css, /\.signer-provider-selector-control select\s*\{[\s\S]*?background-color:\s*var\(--surface-dark-color\)[\s\S]*?color:\s*var\(--text-color\)/)
	assert.match(css, /\.signer-provider-selector-control select\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis/)
})
