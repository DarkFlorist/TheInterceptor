import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SigningQrScanner } from '../../app/ts/components/subcomponents/SigningQr.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'

function deferred<Value>() {
	let resolve: ((value: Value) => void) | undefined
	let reject: ((error: Error) => void) | undefined
	const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline })
	return { promise, resolve: (value: Value) => resolve?.(value), reject: (error: Error) => reject?.(error) }
}

function cameraStream() {
	let stopped = false
	return { stream: { getTracks: () => [{ stop: () => { stopped = true } }] }, wasStopped: () => stopped }
}

function scannerFixture(getUserMedia: () => Promise<ReturnType<typeof cameraStream>['stream']>) {
	const dom = installDomMock()
	const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } })
	act(() => { render(h(SigningQrScanner, { onFrame: async () => false }), dom.document.body) })
	const button = (text: string) => {
		const element = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === text)
		if (element === undefined) throw new Error(`Missing ${ text } button`)
		return element
	}
	return {
		dom, button,
		close: () => act(() => { render(undefined, dom.document.body) }),
		restore: () => {
			act(() => { render(undefined, dom.document.body) })
			if (previousNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator')
			else Object.defineProperty(globalThis, 'navigator', previousNavigator)
			dom.restore()
		},
	}
}

test('camera startup is serialized and late permission results release every cancelled stream', async () => {
	const first = cameraStream()
	const second = cameraStream()
	const firstPermission = deferred<typeof first.stream>()
	const secondPermission = deferred<typeof second.stream>()
	let acquisitions = 0
	const fixture = scannerFixture(() => ++acquisitions === 1 ? firstPermission.promise : secondPermission.promise)
	try {
		const enable = fixture.button('Enable camera')
		await act(async () => { await Promise.all([clickRenderedElement(enable), clickRenderedElement(enable), clickRenderedElement(enable)]) })
		expect(acquisitions).toBe(1)
		await act(async () => { await clickRenderedElement(fixture.button('Stop camera')) })
		await act(async () => { await clickRenderedElement(fixture.button('Enable camera')) })
		expect(acquisitions).toBe(2)
		await act(async () => { firstPermission.resolve(first.stream); await firstPermission.promise })
		expect(first.wasStopped()).toBe(true)
		expect(fixture.button('Stop camera')).toBeDefined()
		fixture.close()
		await act(async () => { secondPermission.resolve(second.stream); await secondPermission.promise })
		expect(second.wasStopped()).toBe(true)
	} finally { fixture.restore() }
})

test('camera permission rejection releases the startup guard for retry', async () => {
	const permission = deferred<ReturnType<typeof cameraStream>['stream']>()
	let acquisitions = 0
	const fixture = scannerFixture(() => { acquisitions += 1; return permission.promise })
	try {
		await act(async () => { await clickRenderedElement(fixture.button('Enable camera')) })
		await act(async () => { permission.reject(new Error('Permission denied')); await permission.promise.catch(() => undefined) })
		expect(fixture.dom.document.body.textContent).toContain('Permission denied')
		await act(async () => { await clickRenderedElement(fixture.button('Enable camera')) })
		expect(acquisitions).toBe(2)
	} finally { fixture.restore() }
})

test('camera playback failure releases the acquired stream and allows retry', async () => {
	const camera = cameraStream()
	let acquisitions = 0
	const fixture = scannerFixture(async () => { acquisitions += 1; return camera.stream })
	try {
		const video = findRenderedElement(fixture.dom.document.body, (node) => node.tagName === 'VIDEO')
		if (video === undefined) throw new Error('Missing video element')
		Object.defineProperty(video, 'play', { value: async () => { throw new Error('Playback failed') } })
		await act(async () => { await clickRenderedElement(fixture.button('Enable camera')) })
		expect(camera.wasStopped()).toBe(true)
		expect(fixture.dom.document.body.textContent).toContain('Playback failed')
		await act(async () => { await clickRenderedElement(fixture.button('Enable camera')) })
		expect(acquisitions).toBe(2)
	} finally { fixture.restore() }
})

test('each scan attempt resets protocol state before acquiring the camera', async () => {
	const dom = installDomMock()
	const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
	const order: string[] = []
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { order.push('camera'); throw new Error('Camera unavailable') } } } })
	try {
		act(() => { render(h(SigningQrScanner, { onFrame: async () => false, onStart: () => { order.push('reset') }, onError: () => { order.push('error') } }), dom.document.body) })
		for (let index = 0; index < 2; index++) {
			const button = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === 'Enable camera')
			if (button === undefined) throw new Error('Missing camera retry')
			await act(async () => { await clickRenderedElement(button) })
		}
		expect(order).toEqual(['reset', 'camera', 'error', 'reset', 'camera', 'error'])
	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator')
		else Object.defineProperty(globalThis, 'navigator', previousNavigator)
		dom.restore()
	}
})
