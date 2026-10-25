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
	await waitForSelector(page, '.management-embedded-frame .simulation-stack-page-header')
	const embeddedHeaderPosition = await page.evaluate<string>(`getComputedStyle(document.querySelector('.management-embedded-frame .simulation-stack-page-header')).position`)
	assert.equal(embeddedHeaderPosition, 'sticky')
	const stickyHeaderGeometry = await page.evaluate<{ frameTop: number, headerTop: number, scrollTop: number }>(`(() => {
		const frame = document.querySelector('.management-embedded-frame--scrollable')
		const page = document.querySelector('.simulation-stack-page')
		const header = document.querySelector('.simulation-stack-page-header')
		if (!(frame instanceof HTMLElement) || !(page instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error('Simulation Stack frame is missing')
		const filler = document.createElement('div')
		filler.style.height = '1200px'
		page.append(filler)
		frame.scrollTop = 200
		return { frameTop: frame.getBoundingClientRect().top, headerTop: header.getBoundingClientRect().top, scrollTop: frame.scrollTop }
	})()`)
	assert.ok(stickyHeaderGeometry)
	assert.ok(stickyHeaderGeometry.scrollTop > 0, 'Simulation Stack frame must scroll')
	assertNear(stickyHeaderGeometry.headerTop, stickyHeaderGeometry.frameTop, 'Simulation Stack header stays inside its frame while scrolling')
	await page.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 700, deviceScaleFactor: 1, mobile: false })
	const narrowStackGeometry = await page.evaluate<{ frameTop: number, navigationBottom: number, headerTop: number, scrollTop: number, navigationIsOnTop: boolean }>(`(() => {
		const navigation = document.querySelector('.management-header')
		const frame = document.querySelector('.management-embedded-frame--scrollable')
		const header = document.querySelector('.simulation-stack-page-header')
		if (!(navigation instanceof HTMLElement) || !(frame instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error('Narrow Simulation Stack frame is missing')
		frame.scrollTop = 200
		return {
			frameTop: frame.getBoundingClientRect().top,
			navigationBottom: navigation.getBoundingClientRect().bottom,
			headerTop: header.getBoundingClientRect().top,
			scrollTop: frame.scrollTop,
			navigationIsOnTop: navigation.contains(document.elementFromPoint(100, 30)),
		}
	})()`)
	assert.ok(narrowStackGeometry)
	assert.ok(narrowStackGeometry.scrollTop > 0, 'Narrow Simulation Stack frame must scroll')
	assertNear(narrowStackGeometry.frameTop, narrowStackGeometry.navigationBottom, 'Narrow stack frame begins below management navigation')
	assertNear(narrowStackGeometry.headerTop, narrowStackGeometry.frameTop, 'Narrow stack header stays inside its frame while scrolling')
	assert.equal(narrowStackGeometry.navigationIsOnTop, true, 'Narrow management navigation stays above the stack header')
	await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false })

	await page.send('Page.navigate', { url: `chrome-extension://${ extensionId }/html3/addressBookV3.html` })
	await waitForSelector(page, '.address-book-list')
	const standaloneAddressBookBottom = await page.evaluate<number>(`document.querySelector('.address-book-content').getBoundingClientRect().bottom`)
	assert.ok(standaloneAddressBookBottom !== undefined)
	assertNear(standaloneAddressBookBottom, 700, 'Standalone Address Book fills its page frame')

	await page.send('Page.navigate', { url: `chrome-extension://${ extensionId }/html3/simulationStackV3.html` })
	await waitForSelector(page, '.simulation-stack-page-header')
	const standaloneHeaderPosition = await page.evaluate<string>(`getComputedStyle(document.querySelector('.simulation-stack-page-header')).position`)
	assert.equal(standaloneHeaderPosition, 'sticky')
	const standaloneStickyHeaderTop = await page.evaluate<number>(`(() => {
		const page = document.querySelector('.simulation-stack-page')
		const header = document.querySelector('.simulation-stack-page-header')
		if (!(page instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error('Standalone Simulation Stack is missing')
		const filler = document.createElement('div')
		filler.style.height = '1200px'
		page.append(filler)
		window.scrollTo(0, 200)
		return header.getBoundingClientRect().top
	})()`)
	assert.ok(standaloneStickyHeaderTop !== undefined)
	assertNear(standaloneStickyHeaderTop, 0, 'Standalone Simulation Stack header stays at the viewport top')

	console.info('Management layout geometry passed in Chromium')
} finally {
	page?.close()
	if (targetId !== undefined) await closeTarget(session.browserConnection, targetId)
	await session.close()
}
