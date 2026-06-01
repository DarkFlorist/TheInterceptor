import * as assert from 'assert'
import { describe, test } from 'bun:test'

describe('ConfirmTransaction signable message disable logic', () => {
	test('disables unsupported signable messages unless force send is enabled', async () => {
		;(
			globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }
		).chrome = { runtime: { id: 'test-extension' } }
		const { shouldDisableSignableMessageConfirm } = await import(
			'../../app/ts/components/pages/ConfirmTransaction.js'
		)
		assert.equal(
			shouldDisableSignableMessageConfirm({
				isValidMessage: true,
				canSignMessage: false,
				forceSendEnabled: false,
				hasSupportedRpc: false,
			}),
			true,
		)
	})

	test('allows unsupported signable messages when force send is enabled', async () => {
		;(
			globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }
		).chrome = { runtime: { id: 'test-extension' } }
		const { shouldDisableSignableMessageConfirm } = await import(
			'../../app/ts/components/pages/ConfirmTransaction.js'
		)
		assert.equal(
			shouldDisableSignableMessageConfirm({
				isValidMessage: true,
				canSignMessage: false,
				forceSendEnabled: true,
				hasSupportedRpc: false,
			}),
			false,
		)
	})
})
