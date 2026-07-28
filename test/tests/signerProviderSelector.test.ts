import * as assert from 'assert'
import { test } from 'bun:test'
import { signerProviderOptionLabel, signerProviderUuidSuffix } from '../../app/ts/components/pages/Home.js'

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
	assert.equal(signerProviderUuidSuffix(firstProvider.uuid), '11111111')
	assert.equal(signerProviderUuidSuffix(secondProvider.uuid), '22222222')
})

test('signer provider selector renders a contained logo-led accessible dropdown', async () => {
	const [homeSource, css] = await Promise.all([
		Bun.file('app/ts/components/pages/Home.tsx').text(),
		Bun.file('app/css/interceptor.css').text(),
	])

	assert.match(homeSource, /<SignerProviderLogo provider = \{ provider \}\/>/)
	assert.match(homeSource, /aria-haspopup = 'listbox'/)
	assert.match(homeSource, /class = 'signer-provider-options' role = 'listbox'/)
	assert.match(homeSource, /role = 'option'/)
	assert.doesNotMatch(homeSource, /<select/)
	assert.match(css, /\.signer-provider-selector-label\s*\{[\s\S]*?color:\s*var\(--text-color\)/)
	assert.match(css, /\.signer-provider-trigger,\s*\.signer-provider-option\s*\{[\s\S]*?grid-template-columns:\s*2rem minmax\(0, 1fr\) 1rem[\s\S]*?width:\s*100%/)
	assert.match(css, /\.signer-provider-logo-frame img\s*\{[\s\S]*?object-fit:\s*contain/)
	assert.match(css, /\.signer-provider-name,\s*\.signer-provider-metadata,\s*\.signer-provider-rdns\s*\{[\s\S]*?text-overflow:\s*ellipsis/)
	assert.match(css, /\.signer-provider-options\s*\{[\s\S]*?max-height:\s*16rem[\s\S]*?overflow-y:\s*auto/)
})
