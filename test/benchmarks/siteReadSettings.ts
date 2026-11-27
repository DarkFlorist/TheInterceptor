import * as assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { launchBrowserSession, selectedBrowser, waitForBrowserCondition } from './browserHarness.js'
import type { BrowserPage } from './browserTypes.js'
import { getGnosisSafeUiScreenshotSettings } from './gnosisSafeUiScreenshotSettings.js'

const hostingLabel = 'Enable Gnosis Safe App hosting'
const readsLabel = 'Enable simulated website HTTP reads'
const findCheckbox = `(text) => [...document.querySelectorAll('label')].find(label => label.textContent.trim().startsWith(text))?.querySelector('input[type="checkbox"]')`

type SettingsState = {
	readonly storedHosting?: boolean
	readonly storedReads?: boolean
	readonly checkedHosting?: boolean
	readonly checkedReads?: boolean
	readonly replyHosting?: boolean
	readonly replyReads?: boolean
}

async function waitForSettings(page: BrowserPage, hosting: boolean, reads: boolean) {
	let state: SettingsState | undefined
	await waitForBrowserCondition(async () => {
		state = await page.evaluate<SettingsState>(`(async () => {
			const stored = await browser.storage.local.get(['safeAppsCompatibilityMode', 'siteRpcInterceptionEnabled']);
			const checkbox = ${ findCheckbox };
			return {
				storedHosting: stored.safeAppsCompatibilityMode,
				storedReads: stored.siteRpcInterceptionEnabled,
				checkedHosting: checkbox(${ JSON.stringify(hostingLabel) })?.checked,
				checkedReads: checkbox(${ JSON.stringify(readsLabel) })?.checked,
				replyHosting: globalThis.siteReadSettingsReply?.safeAppsCompatibilityMode,
				replyReads: globalThis.siteReadSettingsReply?.siteRpcInterceptionEnabled
			};
		})()`)
		return state !== undefined && (state.storedHosting ?? false) === hosting && (state.storedReads ?? false) === reads
			&& state.checkedHosting === hosting && state.checkedReads === reads && state.replyHosting === hosting && state.replyReads === reads
	}, `persisted and hydrated settings: hosting=${ hosting }, HTTP reads=${ reads }`)
	assert.ok(state)
	return state
}

async function clickSetting(page: BrowserPage, label: string, hosting: boolean, reads: boolean) {
	assert.equal(await page.evaluate(`(() => {
		const checkbox = (${ findCheckbox })(${ JSON.stringify(label) });
		if (!(checkbox instanceof HTMLInputElement) || checkbox.disabled) return false;
		globalThis.siteReadSettingsReply = undefined;
		checkbox.click();
		return true;
	})()`), true, `Click the real settings checkbox: ${ label }`)
	const state = await waitForSettings(page, hosting, reads)
	// Once a checkbox has been used, the background settings owner must persist its historical/new boolean key.
	if (label === hostingLabel) assert.equal(state.storedHosting, hosting)
	if (label === readsLabel) assert.equal(state.storedReads, reads)
}

const session = await launchBrowserSession(selectedBrowser())
try {
	await session.setViewport(1280, 1100)
	const settings = await session.openExtensionPage('html/settingsView.html')
	try {
		await waitForBrowserCondition(async () => await settings.evaluate(`(${ findCheckbox })(${ JSON.stringify(readsLabel) }) instanceof HTMLInputElement`), 'settings checkbox rendering')
		// Reset only these preferences so the scenario also starts clean with an explicitly reused browser profile.
		await settings.evaluate(`(async () => {
			await browser.storage.local.remove(['safeAppsCompatibilityMode', 'siteRpcInterceptionEnabled']);
			browser.runtime.onMessage.addListener(message => {
				if (message?.method === 'popup_requestSettingsReply') globalThis.siteReadSettingsReply = message.data;
				return false;
			});
			globalThis.siteReadSettingsReply = undefined;
			await browser.runtime.sendMessage({ method: 'popup_requestSettings' });
		})()`)
		await waitForSettings(settings, false, false)
		await clickSetting(settings, hostingLabel, true, false)
		await clickSetting(settings, hostingLabel, false, false)
		await clickSetting(settings, readsLabel, false, true)
		await clickSetting(settings, hostingLabel, true, true)
		await clickSetting(settings, readsLabel, true, false)
		await clickSetting(settings, readsLabel, true, true)
		await settings.reload()
		// Reload verifies the checked state is restored from background storage, without the scenario's reply observer.
		await waitForBrowserCondition(async () => await settings.evaluate(`(() => {
			const checkbox = ${ findCheckbox };
			return checkbox(${ JSON.stringify(hostingLabel) })?.checked === true && checkbox(${ JSON.stringify(readsLabel) })?.checked === true;
		})()`), 'both persisted settings after reload')
		assert.deepEqual(await settings.evaluate(`browser.storage.local.get(['safeAppsCompatibilityMode', 'siteRpcInterceptionEnabled'])`), { safeAppsCompatibilityMode: true, siteRpcInterceptionEnabled: true })
		const { outputDirectory } = getGnosisSafeUiScreenshotSettings()
		await mkdir(outputDirectory, { recursive: true })
		const screenshotPath = path.join(outputDirectory, `gnosis-safe-session-settings-${ session.browser }.png`)
		await Bun.write(screenshotPath, Buffer.from(await settings.captureScreenshot(), 'base64'))
		console.warn(`${ session.browser } independent settings UI passed; screenshot: ${ screenshotPath }`)
	} finally { await settings.close() }
} finally { await session.close() }
