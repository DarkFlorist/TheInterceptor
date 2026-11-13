import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { getPopupMessageSenderKind, isPopupMessageAllowedFromSender } from '../../app/ts/background/popupMessageSenderPolicy.js'
import { isPopupMessageMethod, popupMessageProtocol, requiresExtensionPageSender } from '../../app/ts/types/popupMessageProtocol.js'

const extensionId = 'interceptor-id'
const extensionRootUrl = 'chrome-extension://interceptor-id/'
const contentScript = { id: extensionId, url: 'https://app.example/', tab: { id: 1 } }
const popupMethods = Object.keys(popupMessageProtocol).filter(isPopupMessageMethod)
const extensionPageOnlyMethods = popupMethods.filter(requiresExtensionPageSender)

describe('popup message sender policy', () => {
	test('classifies only this extension\'s own pages as extension pages', () => {
		const extensionPage = { id: extensionId, url: `${ extensionRootUrl }settings.html` }
		expect(getPopupMessageSenderKind(extensionPage, extensionId, extensionRootUrl)).toBe('extension-page')
		expect(getPopupMessageSenderKind({ ...extensionPage, tab: { id: 1 } }, extensionId, extensionRootUrl)).toBe('extension-page')
		const otherExtension = { id: 'other-id', url: 'chrome-extension://other-id/settings.html' }
		const sameIdWrongUrl = { id: extensionId, url: 'chrome-extension://interceptor-id.evil/settings.html' }
		for (const sender of [contentScript, otherExtension, sameIdWrongUrl, { id: extensionId }]) {
			expect(getPopupMessageSenderKind(sender, extensionId, extensionRootUrl)).toBe('other')
		}
	})

	test('Safe App preparation and cancellation are declared extension-page only', () => {
		expect(extensionPageOnlyMethods).toContain('popup_prepareSafeApp')
		expect(extensionPageOnlyMethods).toContain('popup_cancelPrepareSafeApp')
	})

	test('every protocol entry flagged extension-page only is rejected for a content script sender', () => {
		const senderKind = getPopupMessageSenderKind(contentScript, extensionId, extensionRootUrl)
		for (const method of popupMethods) {
			expect({ method, allowed: isPopupMessageAllowedFromSender({ method, data: {} }, senderKind) }).toEqual({ method, allowed: !requiresExtensionPageSender(method) })
		}
	})

	test('extension pages may send every protocol method', () => {
		for (const method of popupMethods) expect(isPopupMessageAllowedFromSender({ method }, 'extension-page')).toBe(true)
	})

	test('leaves messages without a known popup method to the parser', () => {
		for (const message of [undefined, 'popup_prepareSafeApp', {}, { method: 1 }, { method: 'not_a_popup_method' }, { method: 'toString' }]) {
			expect(isPopupMessageAllowedFromSender(message, 'other')).toBe(true)
		}
	})

	test('the message boundary derives sender privilege from protocol metadata instead of method names', () => {
		const backgroundStartupSource = fs.readFileSync('app/ts/background/background-startup.ts', 'utf8')
		expect(backgroundStartupSource).toContain('isPopupMessageAllowedFromSender(message, getPopupMessageSenderKind(sender,')
		for (const method of extensionPageOnlyMethods) expect(backgroundStartupSource).not.toContain(method)
		const policySource = fs.readFileSync('app/ts/background/popupMessageSenderPolicy.ts', 'utf8')
		for (const method of popupMethods) expect(policySource).not.toContain(`'${ method }'`)
		expect(fs.existsSync('app/ts/background/safeAppsPreparationSender.ts')).toBe(false)
	})
})
