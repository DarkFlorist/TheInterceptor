import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { ProviderErrors } from '../../app/ts/components/subcomponents/ProviderErrors.js'
import type { SignerName } from '../../app/ts/types/signerTypes.js'
import type { TabState } from '../../app/ts/types/user-interface-types.js'
import { DEFAULT_TAB_CONNECTION } from '../../app/ts/utils/constants.js'
import { installDomMock } from './domMock.js'

function createTabState(signerName: SignerName): TabState {
	return {
		tabId: 1,
		website: undefined,
		signerConnected: false,
		signerName,
		signerAccounts: [],
		signerChain: undefined,
		signerAccountError: { code: 4900, message: 'Signer unavailable' },
		tabIconDetails: DEFAULT_TAB_CONNECTION,
		activeSigningAddress: undefined,
	}
}

describe('provider account errors', () => {
	test('does not render a warning when no signer is available', () => {
		const dom = installDomMock()
		try {
			const tabState = signal<TabState | undefined>(createTabState('NoSigner'))
			render(h(ProviderErrors, { tabState }), dom.document.body)
			assert.equal(dom.document.body.textContent, '')

			tabState.value = createTabState('NoSignerDetected')
			assert.equal(dom.document.body.textContent, '')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps warnings from an identified signer visible', () => {
		const dom = installDomMock()
		try {
			const tabState = signal<TabState | undefined>(createTabState('MetaMask'))
			render(h(ProviderErrors, { tabState }), dom.document.body)
			assert.match(dom.document.body.textContent, /MetaMask returned error: "Signer unavailable"/)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
