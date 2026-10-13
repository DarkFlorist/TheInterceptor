import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { act } from 'preact/test-utils'
import { h, render } from 'preact'
import { App } from '../../app/ts/components/App.js'
import { Settings } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { ICON_SIGNING, ICON_SIMULATING } from '../../app/ts/utils/constants.js'
import { installDomMock } from './domMock.js'
import { collectImageSources, defaultHomePage, defaultSettings } from './popupAppTestHarness.js'
import { isHomeDataRequest } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('popup icon sync', () => {
	test('ignores icon updates for a different tab id', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')
			const initialMessage = defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 1)

			await act(() => {
				// first message should establish the active tab id
				messaging.dispatch({ role: 'all', ...initialMessage })
			})
			assert.equal(messaging.sentMessages.length > 0, true)

			const iconSrcAfterHomePage = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterHomePage?.endsWith('head-signing.png'), true)

			await act(() => {
				// stale icon update for another tab must not override current tab icon
				messaging.dispatch({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 2,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				})
			})
			const iconSrcAfterWrongTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterWrongTabUpdate?.endsWith('head-signing.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('does not apply icon updates while tab id is unknown', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 2,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				})
			})

			const iconSrcAfterUnknownTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconSrcAfterUnknownTabUpdate, undefined)
		} finally {
			dom.restore()
		}
	})

	test('ignores stale popup home updates', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				})
			})
			const iconAfterCurrentTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 5),
				})
			})
			const iconAfterStaleUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 20),
					method: 'popup_UpdateHomePage',
				})
			})
			const iconAfterFreshUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterFreshUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('does not apply higher-generation updates for a non-current tab', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				})
			})
			const iconAfterCurrentTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(2, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 20),
				})
			})
			const iconAfterWrongTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterWrongTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 11),
					method: 'popup_UpdateHomePage',
				})
			})
			const iconAfterCurrentTabFreshUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabFreshUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('non-current icon updates do not block later current tab icon updates', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				})
			})
			const iconAfterCurrentTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 20,
					tabId: 2,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				})
			})
			const iconAfterWrongTabIconUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterWrongTabIconUpdate?.endsWith('head-signing.png'), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 11,
					tabId: 1,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				})
			})
			const iconAfterCurrentTabIconUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabIconUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('same-tab icon updates update refresh generation to protect stale home payloads', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				})
			})

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_websiteIconChanged',
					popupRefreshGeneration: 20,
					tabId: 1,
					data: { icon: ICON_SIMULATING, iconReason: 'Simulating' },
				})
			})

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 15),
				})
			})
			const iconAfterStaleHomeUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleHomeUpdate?.endsWith('head-simulating.png'), true)
		} finally {
			dom.restore()
		}
	})

	test('settings update blocks stale home updates with lower generation', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {

			await act(() => {
				render(h(App, {}), dom.document.body)
			})
			assert.ok(messaging.listenerCount() > 0, 'Expected the popup to listen for runtime messages')

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIGNING, iconReason: 'Signing' }, 10),
				})
			})
			const iconAfterCurrentTabUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterCurrentTabUpdate?.endsWith('head-signing.png'), true)
			messaging.sentMessages.splice(0)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					method: 'popup_settingsUpdated',
					popupRefreshGeneration: 20,
					data: serialize(Settings, defaultSettings),
				})
			})
			assert.equal(messaging.sentMessages.some((message) => isHomeDataRequest(message, false, true)), true)

			await act(() => {
				messaging.dispatch({
					role: 'all',
					...defaultHomePage(1, { icon: ICON_SIMULATING, iconReason: 'Simulating' }, 5),
				})
			})
			const iconAfterStaleHomeAfterSettingsUpdate = collectImageSources(dom.document.body).find((src) => src.includes('head-'))
			assert.equal(iconAfterStaleHomeAfterSettingsUpdate?.endsWith('head-signing.png'), true)
		} finally {
			dom.restore()
		}
	})
})
