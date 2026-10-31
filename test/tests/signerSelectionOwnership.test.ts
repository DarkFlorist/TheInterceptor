import * as assert from 'assert'
import { test } from 'bun:test'
import { getExplicitSignerSelection, getExplicitSignerSelectionForConnection } from '../../app/ts/background/signerSelectionOwnership.js'

const provider = { uuid: '11111111-1111-4111-8111-111111111111', rdns: 'app.example', name: 'Wallet', icon: 'data:image/svg+xml,<svg/>' }
const selection = { selectedSignerProvider: provider, explicitlySelectedSignerProviderUuid: provider.uuid, selectedSignerConnectionName: 1n, website: { websiteOrigin: 'app.example', title: undefined, icon: undefined } }

test('only the explicitly selected provider for the same origin and connection can be restored', () => {
	assert.equal(getExplicitSignerSelectionForConnection(selection, 'app.example', 1n), provider)
	assert.equal(getExplicitSignerSelectionForConnection(selection, 'other.example', 1n), undefined)
	assert.equal(getExplicitSignerSelectionForConnection(selection, 'app.example', 2n), undefined)
	assert.equal(getExplicitSignerSelection({ ...selection, explicitlySelectedSignerProviderUuid: undefined }), undefined)
	assert.equal(getExplicitSignerSelection({ ...selection, selectedSignerConnectionName: undefined }), undefined)
	assert.equal(getExplicitSignerSelection({ ...selection, selectedSignerProvider: undefined }), undefined)
	// A child reconnect may preserve storage for the top to prove later; it cannot claim the top's authority.
	assert.equal(getExplicitSignerSelection(selection), provider)
	assert.equal(getExplicitSignerSelectionForConnection(selection, 'app.example', 99n), undefined)
})
