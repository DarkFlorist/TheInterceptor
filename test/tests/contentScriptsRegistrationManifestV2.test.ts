import * as assert from 'node:assert'
import * as fs from 'node:fs'
import { describe, test } from 'bun:test'
import { ExportedSettings } from '../../app/ts/types/exportedSettingsTypes.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { flushMicrotasks, waitFor } from '../harness/async.js'
import { replaceProperty } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { withSilencedConsole } from './consoleSilence.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'

const { installBrowserMockForTest, restoreAfterTest } = createPerTestRestorer()

type Registration = {
	readonly options: browser.contentScripts.RegisteredContentScriptOptions
	unregistered: boolean
}

// Firefox's contentScripts API, which the shared browser mock does not provide. Each register call can be held until the test releases it, so tests can overlap updates.
function installManifestV2BrowserMock({ registerError }: { readonly registerError?: Error } = {}) {
	const browserMock = installBrowserMockForTest({ manifestVersion: 2 })
	const registrations: Registration[] = []
	const heldRegistrations: (() => void)[] = []
	let holdRegistrations = false
	let failedUnregistrations = 0
	restoreAfterTest(replaceProperty(browserMock.browser, 'contentScripts', {
		register: async (options: browser.contentScripts.RegisteredContentScriptOptions): Promise<browser.contentScripts.RegisteredContentScript> => {
			if (holdRegistrations) await new Promise<void>((resolve) => { heldRegistrations.push(resolve) })
			if (registerError !== undefined) throw registerError
			// Firefox validates the options this way (seen in Firefox 153 ESR); an empty excludeGlobs array is accepted.
			if (options.excludeMatches?.length === 0) throw new Error('Type error for parameter contentScriptOptions (Error processing excludeMatches: Array requires at least 1 items; you have 0) for contentScripts.register.')
			const registration: Registration = { options, unregistered: false }
			registrations.push(registration)
			return {
				unregister: async () => {
					if (failedUnregistrations > 0) {
						failedUnregistrations -= 1
						throw new Error('unregister failed')
					}
					registration.unregistered = true
				},
			}
		},
	}))
	return {
		browserMock,
		registrations,
		activeRegistrations: () => registrations.filter((registration) => !registration.unregistered),
		holdRegistrations: () => { holdRegistrations = true },
		releaseHeldRegistration: () => { heldRegistrations.shift()?.() },
		heldRegistrationCount: () => heldRegistrations.length,
		failNextUnregistrations: (count: number) => { failedUnregistrations = count },
	}
}

async function loadModules() {
	return {
		...await import('../../app/ts/utils/contentScriptsUpdating.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/websiteAccessUpdating.js'),
		...await import('../../app/ts/background/popupMessageHandlers/settings.js'),
	}
}

const disabledSite = (websiteOrigin: string) => ({ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: undefined, interceptorDisabled: true })

// Typed as the whole union, which serialize needs, rather than narrowed to the 1.0 member by the literal.
const buildExportWithDisabledSite = (websiteOrigin: string): ExportedSettings => ({
	name: 'InterceptorSettingsAndAddressBook',
	version: '1.0',
	exportedDate: '2026-10-26',
	settings: {
		activeSimulationAddress: 0x1010101010101010101010101010101010101010n,
		activeChain: 1n,
		useSignersAddressAsActiveAddress: false,
		websiteAccess: [disabledSite(websiteOrigin)],
		simulationMode: false,
		addressInfos: [],
		contacts: undefined,
		useTabsInsteadOfPopup: false,
	},
})

function getManifestV2(): unknown {
	return JSON.parse(fs.readFileSync('app/manifestV2.json', 'utf8'))
}

describe('manifest v2 content script registration', () => {
	test('registers the content scripts for the top frame at document_start and exposes every injected file', async () => {
		const { registrations, browserMock } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()

		await updateContentScriptInjectionStrategyManifestV2()

		const injectedFiles = ['/vendor/webextension-polyfill/dist/browser-polyfill.js', '/inpage/js/listenContentScript.js', '/inpage/js/document_start.js']
		assert.equal(registrations.length, 1)
		assert.deepEqual(registrations[0]?.options, {
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			excludeGlobs: [],
			js: injectedFiles.map((file) => ({ file })),
			runAt: 'document_start',
			allFrames: false,
		})
		// Navigations no longer inject anything, so nothing waits on settings while the page's first scripts run.
		assert.equal(browserMock.browser.webNavigation.onCommitted.hasListeners(), false)
		const manifest = getManifestV2()
		if (typeof manifest !== 'object' || manifest === null || !('web_accessible_resources' in manifest) || !('permissions' in manifest)) throw new Error('Manifest V2 must declare web-accessible resources and permissions')
		assert.deepEqual(manifest.web_accessible_resources, [...injectedFiles.map((file) => file.slice(1)), 'inpage/js/inpage.js'])
		assert.ok(Array.isArray(manifest.permissions) && !manifest.permissions.includes('webNavigation'))
	})

	test('keeps exactly the sites where the Interceptor is disabled out of the registration, not their subdomains or other ports', async () => {
		const { registrations } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccess } = await loadModules()
		await updateWebsiteAccess(() => [disabledSite('example.com'), disabledSite('localhost:3000'), disabledSite('example.org:80'), disabledSite('example.org:443'), disabledSite('https://secure.example'), disabledSite('')])

		await updateContentScriptInjectionStrategyManifestV2()

		// Globs match the URL text, so http://example.com/* leaves evil.example.com and example.com:8443 alone: each is a separate website for the access policy.
		assert.equal(registrations[0]?.options.excludeMatches, undefined)
		assert.deepEqual(registrations[0]?.options.excludeGlobs, [
			'http://example.com/*',
			'https://example.com/*',
			'http://localhost:3000/*',
			'https://localhost:3000/*',
			// A stored host with a scheme's default port can only come from the other scheme's URL.
			'https://example.org:80/*',
			'http://example.org:443/*',
			'https://secure.example/*',
			'file:///*',
		])
	})

	test('re-registers with the new exclusions when the disabled sites change, and removes the previous registration only after that', async () => {
		const { registrations, activeRegistrations } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccessAndContentScriptInjectionStrategy } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()

		await updateWebsiteAccessAndContentScriptInjectionStrategy(() => [disabledSite('example.com')])

		assert.equal(registrations.length, 2)
		assert.deepEqual(activeRegistrations().map(({ options }) => options.excludeGlobs), [['http://example.com/*', 'https://example.com/*']])
		assert.equal(registrations[0]?.unregistered, true)

		// Re-enabling the site registers again without the exclusion.
		await updateWebsiteAccessAndContentScriptInjectionStrategy(() => [])
		assert.deepEqual(activeRegistrations().map(({ options }) => options.excludeGlobs), [[]])
	})

	test('does not re-register when an access change leaves the disabled sites as they were', async () => {
		const { registrations } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccessAndContentScriptInjectionStrategy } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()

		await updateWebsiteAccessAndContentScriptInjectionStrategy(() => [{ website: { websiteOrigin: 'example.com', icon: undefined, title: undefined }, addressAccess: undefined, access: true }])

		assert.equal(registrations.length, 1)
	})

	test('registers again with the imported disabled sites after a settings import', async () => {
		const { activeRegistrations } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, importSettings } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()

		const reply = await importSettings({ method: 'popup_import_settings', data: { fileContents: JSON.stringify(serialize(ExportedSettings, buildExportWithDisabledSite('example.com'))) } })

		assert.deepEqual(reply.data, { success: true })
		assert.deepEqual(activeRegistrations().map(({ options }) => options.excludeGlobs), [['http://example.com/*', 'https://example.com/*']])
	})

	test('applies overlapping updates in order, so the newest disabled-site list stays registered', async () => {
		const { registrations, activeRegistrations, holdRegistrations, releaseHeldRegistration, heldRegistrationCount } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccess } = await loadModules()
		holdRegistrations()

		const firstUpdate = updateContentScriptInjectionStrategyManifestV2()
		await waitFor(() => heldRegistrationCount() === 1)
		await updateWebsiteAccess(() => [disabledSite('example.com')])
		const secondUpdate = updateContentScriptInjectionStrategyManifestV2()
		// The second update waits for the first instead of registering alongside it, so it cannot finish first and then be replaced by the older list.
		await flushMicrotasks()
		assert.equal(heldRegistrationCount(), 1)
		releaseHeldRegistration()
		await firstUpdate
		await waitFor(() => heldRegistrationCount() === 1)
		releaseHeldRegistration()
		await secondUpdate

		assert.equal(registrations.length, 2)
		assert.deepEqual(activeRegistrations().map(({ options }) => options.excludeGlobs), [['http://example.com/*', 'https://example.com/*']])
	})

	test('keeps a registration whose removal failed and removes it on a later update', async () => {
		const { activeRegistrations, failNextUnregistrations, browserMock } = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2, updateWebsiteAccessAndContentScriptInjectionStrategy } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()

		failNextUnregistrations(1)
		await withSilencedConsole(async () => await updateWebsiteAccessAndContentScriptInjectionStrategy(() => [disabledSite('example.com')]))
		// The registration without the exclusion is still installed, and the failure is reported.
		assert.equal(activeRegistrations().length, 2)
		assert.ok(browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_UnexpectedErrorOccured')))

		await updateWebsiteAccessAndContentScriptInjectionStrategy(() => [disabledSite('example.com'), disabledSite('example.org')])
		assert.deepEqual(activeRegistrations().map(({ options }) => options.excludeGlobs), [['http://example.com/*', 'https://example.com/*', 'http://example.org/*', 'https://example.org/*']])
	})

	test('reports a failed registration and keeps the previous registration', async () => {
		const working = installManifestV2BrowserMock()
		const { updateContentScriptInjectionStrategyManifestV2 } = await loadModules()
		await updateContentScriptInjectionStrategyManifestV2()
		const failing = installManifestV2BrowserMock({ registerError: new Error('registration failed') })

		await withSilencedConsole(async () => await updateContentScriptInjectionStrategyManifestV2())

		assert.deepEqual(working.activeRegistrations().length, 1)
		assert.equal(failing.registrations.length, 0)
		assert.ok(failing.browserMock.calls.runtimeSendMessage.some((message) => hasMessageMethod(message, 'popup_UnexpectedErrorOccured')))
	})
})
