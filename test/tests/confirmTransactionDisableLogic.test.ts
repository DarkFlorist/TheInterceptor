import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'
import { replaceGlobal } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'

// Restores the globals the running test installed, even when one of its assertions fails.
const { installBrowserMockForTest, restoreAfterTest } = createPerTestRestorer()

// The pure ConfirmTransaction helpers only need the extension's chrome.runtime.id, as on a real extension page.
const installExtensionChromeGlobal = () => { restoreAfterTest(replaceGlobal('chrome', { runtime: { id: 'test-extension' } })) }

describe('ConfirmTransaction signable message disable logic', () => {
	test('disables unsupported signable messages unless force send is enabled', async () => {
		installExtensionChromeGlobal()
		const { shouldDisableSignableMessageConfirm } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		assert.equal(shouldDisableSignableMessageConfirm({
			isValidMessage: true,
			canSignMessage: false,
			forceSendEnabled: false,
			hasSupportedRpc: false,
		}), true)
	})

	test('allows unsupported signable messages when force send is enabled', async () => {
		installExtensionChromeGlobal()
		const { shouldDisableSignableMessageConfirm } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		assert.equal(shouldDisableSignableMessageConfirm({
			isValidMessage: true,
			canSignMessage: false,
			forceSendEnabled: true,
			hasSupportedRpc: false,
		}), false)
	})

	test('formats confirm dialog delivery failures for centralized reporting', async () => {
		installExtensionChromeGlobal()
		const { getConfirmDialogDeliveryErrorMessage } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		const message = getConfirmDialogDeliveryErrorMessage(new Error('background unavailable'))

		assert.equal(message, 'Failed to confirm transaction: background unavailable')
	})

	test('reports confirm dialog delivery failures with contextual popup diagnostics', async () => {
		const browserMock = installBrowserMockForTest({
			handlers: {
				runtimeMessage: (message) => {
					if (getMessageMethod(message) === 'popup_confirmDialog') throw new Error('background unavailable')
					if (getMessageMethod(message) === 'popup_UnexpectedErrorOccured') throw new Error('broadcast unavailable')
					return undefined
				},
			},
		})
		const [
			{ sendConfirmDialogMessage },
			{ getLatestUnexpectedError },
		] = await Promise.all([
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
			import('../../app/ts/utils/unexpectedErrorStorage.js'),
		])

		const localError = await withSilencedConsole(async () => await sendConfirmDialogMessage({
			method: 'popup_confirmDialog',
			data: {
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 2, connectionName: 0n } },
				action: 'accept',
			},
		}))

		const latestUnexpectedError = await getLatestUnexpectedError()
		const sentMessages = browserMock.calls.runtimeSendMessage
		assert.equal(getMessageMethod(sentMessages[0]), 'popup_confirmDialog')
		assert.equal(getMessageMethod(sentMessages[1]), 'popup_UnexpectedErrorOccured')
		assert.equal(localError?.message, 'Failed to confirm transaction: background unavailable')
		assert.equal(localError?.code, 'confirm_dialog_delivery_failed')
		assert.equal(localError?.source, 'confirmTransaction')
		assert.equal(latestUnexpectedError?.data.message, 'Failed to confirm transaction: background unavailable')
		assert.equal(latestUnexpectedError?.data.code, 'confirm_dialog_delivery_failed')
		assert.equal(latestUnexpectedError?.data.source, 'confirmTransaction')
	})
})
