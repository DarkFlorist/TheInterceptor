import * as assert from 'node:assert/strict'
import { closeTarget, connectTarget, createTargetPage, launchChromeSession, waitForInterceptorExtensionServiceWorker } from './chromeHarness.js'
import type { CdpConnection } from './chromeHarness.js'

type AddressBookGeometry = {
	viewportHeight: number
	headerBottom: number
	contentTop: number
	contentBottom: number
	listHeight: number
}

async function waitForSelector(connection: CdpConnection, selector: string) {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (await connection.evaluate<boolean>(`document.querySelector(${ JSON.stringify(selector) }) !== null`)) return
		await Bun.sleep(50)
	}
	throw new Error(`Timed out waiting for ${ selector }`)
}

async function readAddressBookGeometry(connection: CdpConnection) {
	const geometry = await connection.evaluate<AddressBookGeometry>(`(() => {
		const header = document.querySelector('.management-header')
		const content = document.querySelector('.address-book-content')
		const list = document.querySelector('.address-book-list')
		if (!(header instanceof HTMLElement) || !(content instanceof HTMLElement) || !(list instanceof HTMLElement)) throw new Error('Address Book layout is missing')
		return {
			viewportHeight: window.innerHeight,
			headerBottom: header.getBoundingClientRect().bottom,
			contentTop: content.getBoundingClientRect().top,
			contentBottom: content.getBoundingClientRect().bottom,
			listHeight: list.getBoundingClientRect().height,
		}
	})()`)
	assert.ok(geometry)
	return geometry
}

function assertNear(actual: number, expected: number, description: string) {
	assert.ok(Math.abs(actual - expected) < 2, `${ description }: expected ${ expected }, got ${ actual }`)
}

const session = await launchChromeSession()
let targetId: string | undefined
let page: CdpConnection | undefined
try {
	const worker = await waitForInterceptorExtensionServiceWorker(session.browserDebugPort)
	const extensionId = new URL(worker.url).host
	targetId = await createTargetPage(session.browserConnection, `chrome-extension://${ extensionId }/html3/settingsViewV3.html#address-book`)
	page = await connectTarget(session.browserDebugPort, targetId)
	await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false })
	await waitForSelector(page, '.address-book-list')

	const initial = await readAddressBookGeometry(page)
	assertNear(initial.contentTop, initial.headerBottom, 'Address Book begins below the header')
	assertNear(initial.contentBottom, initial.viewportHeight, 'Address Book ends at the viewport edge')

	await page.evaluate(`document.querySelector('.management-header').style.paddingBlock = '28px'`)
	const grownHeader = await readAddressBookGeometry(page)
	const headerGrowth = grownHeader.headerBottom - initial.headerBottom
	assert.ok(headerGrowth > 20, 'Header growth must be visible in the rendered layout')
	assertNear(grownHeader.contentTop, grownHeader.headerBottom, 'Address Book follows a taller header')
	assertNear(grownHeader.contentBottom, grownHeader.viewportHeight, 'Address Book remains inside the viewport')
	assertNear(initial.listHeight - grownHeader.listHeight, headerGrowth, 'Address Book list shrinks with the available space')

	await page.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 700, deviceScaleFactor: 1, mobile: false })
	const narrowLayout = await page.evaluate<{ listHeight: number, contentBottom: number, scrollHeight: number }>(`(() => {
		const content = document.querySelector('.address-book-content')
		const list = document.querySelector('.address-book-list')
		if (!(content instanceof HTMLElement) || !(list instanceof HTMLElement)) throw new Error('Narrow Address Book layout is missing')
		return { listHeight: list.getBoundingClientRect().height, contentBottom: content.getBoundingClientRect().bottom, scrollHeight: document.documentElement.scrollHeight }
	})()`)
	assert.ok(narrowLayout)
	assert.ok(narrowLayout.listHeight >= 224, 'Narrow Address Book keeps a usable list viewport')
	assert.ok(narrowLayout.scrollHeight >= narrowLayout.contentBottom, 'Narrow Address Book content remains scrollable')
	await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false })

	await page.evaluate(`(() => {
		const header = document.querySelector('.management-header')
		header.style.zIndex = '999999'
		const overlay = document.createElement('div')
		overlay.className = 'access-details'
		overlay.dataset.managementLayoutCheck = 'overlay'
		document.body.append(overlay)
	})()`)
	const overlayIsAboveHeader = await page.evaluate<boolean>(`document.elementFromPoint(40, 20)?.getAttribute('data-management-layout-check') === 'overlay'`)
	assert.equal(overlayIsAboveHeader, true, 'Website details must cover the management header regardless of its local z-index')

	await page.evaluate(`(() => {
		document.querySelector('[data-management-layout-check]')?.remove()
		document.querySelector('.management-header').style.removeProperty('z-index')
		document.querySelector('.management-header').style.removeProperty('padding-block')
		location.hash = '#simulation-stack'
	})()`)
	await waitForSelector(page, '.management-page .simulation-stack-page-header')
	const embeddedHeaderPosition = await page.evaluate<string>(`getComputedStyle(document.querySelector('.management-page .simulation-stack-page-header')).position`)
	assert.equal(embeddedHeaderPosition, 'static')

	console.info('Management layout geometry passed in Chromium')
} finally {
	page?.close()
	if (targetId !== undefined) await closeTarget(session.browserConnection, targetId)
	await session.close()
}
