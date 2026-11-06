import assert from 'node:assert/strict'
import type { CdpConnection } from './chromeHarness.js'

export async function signingKey(page: CdpConnection, key: 'Tab' | 'Enter' | ' ', shift = false) {
	const code = key === ' ' ? 'Space' : key
	const windowsVirtualKeyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : 32
	await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined, modifiers: shift ? 8 : 0 })
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 })
}

export async function waitForSigningFocus(page: CdpConnection, selector: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await page.evaluate<boolean>(`document.activeElement?.matches(${ JSON.stringify(selector) }) === true`)) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Focus did not reach ${ selector }`)
}

export async function checkSigningAccessibility(page: CdpConnection, captureState: (stage: 'copied' | 'copy-error') => Promise<void>) {
	await page.send('Page.bringToFront')
	await page.evaluate('document.activeElement?.blur()')
	await signingKey(page, 'Tab')
	await waitForSigningFocus(page, 'button[aria-label="Copy acting address"]')
	assert.equal(await page.evaluate(`getComputedStyle(document.activeElement).outlineStyle !== 'none'`), true, 'Keyboard focus must be visible')
	// Verify exact data and announcements independently of OS clipboard availability.
	await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { globalThis.__copiedSigningValue = value } } })`)
	await signingKey(page, 'Enter')
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await page.evaluate<boolean>(`document.querySelector('.signing-copy-value [role="status"]').textContent.includes('copied to clipboard')`)) break
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.equal(await page.evaluate(`globalThis.__copiedSigningValue === document.querySelector('.signing-copy-value .signing-address').textContent`), true, await page.evaluate(`JSON.stringify({ copied: globalThis.__copiedSigningValue, active: document.activeElement?.outerHTML, value: document.querySelector('.signing-copy-value').textContent })`))
	const tree = await page.send<{ nodes: { role?: { value: string }, name?: { value: string }, properties?: { name: string, value: { value: unknown } }[] }[] }>('Accessibility.getFullAXTree')
	assert.ok(tree.nodes.some((node) => node.role?.value === 'button' && node.name?.value === 'Copy acting address'))
	assert.ok(tree.nodes.some((node) => node.role?.value === 'status' && node.properties?.some((property) => property.name === 'live' && property.value.value === 'polite')))
	assert.ok(tree.nodes.some((node) => node.name?.value === 'acting address copied to clipboard.'))
	await captureState('copied')
	await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Denied by fixture', 'NotAllowedError') } } }); document.execCommand = () => false`)
	await signingKey(page, ' ')
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await page.evaluate<boolean>(`document.querySelector('.signing-copy-feedback') !== null`)) break
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.equal(await page.evaluate(`document.querySelector('.signing-copy-feedback')?.textContent.includes('copy it manually')`), true)
	await waitForSigningFocus(page, 'button[aria-label="Copy acting address"]')
	await captureState('copy-error')
	console.info('Keyboard copy preserves exact value, visible focus, AX names/live feedback and permission-failure recovery')
}

export async function checkSigningZoom(page: CdpConnection) {
	await page.evaluate('(async () => { const tab = await browser.tabs.getCurrent(); await browser.tabs.setZoom(tab.id, 2); })()')
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await page.evaluate<boolean>('(async () => { const tab = await browser.tabs.getCurrent(); return await browser.tabs.getZoom(tab.id) === 2 })()')) break
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '200% browser zoom must not overflow horizontally')
	assert.equal(await page.evaluate('(async () => { const tab = await browser.tabs.getCurrent(); return await browser.tabs.getZoom(tab.id) })()'), 2)
	console.info('Native browser zoom 200%: no horizontal overflow')
}
