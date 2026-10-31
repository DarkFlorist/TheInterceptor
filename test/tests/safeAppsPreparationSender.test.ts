import { describe, expect, test } from 'bun:test'
import { canHandleSafeAppPreparationMessage } from '../../app/ts/background/safeAppsPreparationSender.js'

const extensionId = 'interceptor-id'
const extensionRootUrl = 'chrome-extension://interceptor-id/'
const preparation = { method: 'popup_prepareSafeApp', data: { origin: 'https://app.example' } }
const cancellation = { method: 'popup_cancelPrepareSafeApp', data: { origin: 'https://app.example' } }

describe('Safe Apps preparation message sender', () => {
	test('accepts preparation and cancellation from an extension page', () => {
		const extensionPage = { id: extensionId, url: `${ extensionRootUrl }settings.html` }
		const extensionTab = { ...extensionPage, tab: { id: 1 } }
		for (const sender of [extensionPage, extensionTab]) {
			expect(canHandleSafeAppPreparationMessage(preparation, sender, extensionId, extensionRootUrl)).toBe(true)
			expect(canHandleSafeAppPreparationMessage(cancellation, sender, extensionId, extensionRootUrl)).toBe(true)
		}
	})

	test('rejects content scripts and other extension origins', () => {
		const contentScript = { id: extensionId, url: 'https://app.example/', tab: { id: 1 } }
		const otherExtension = { id: 'other-id', url: 'chrome-extension://other-id/settings.html' }
		const sameIdWrongUrl = { id: extensionId, url: 'chrome-extension://interceptor-id.evil/settings.html' }
		for (const sender of [contentScript, otherExtension, sameIdWrongUrl]) {
			expect(canHandleSafeAppPreparationMessage(preparation, sender, extensionId, extensionRootUrl)).toBe(false)
			expect(canHandleSafeAppPreparationMessage(cancellation, sender, extensionId, extensionRootUrl)).toBe(false)
		}
	})

	test('leaves existing background messages on their current route', () => {
		const sender = { id: extensionId, url: 'https://app.example/', tab: { id: 1 } }
		expect(canHandleSafeAppPreparationMessage({ method: 'popup_requestSettings' }, sender, extensionId, extensionRootUrl)).toBe(true)
	})
})
