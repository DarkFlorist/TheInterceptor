import * as assert from 'assert'

export function createGnosisSafeHostHarness({ origin = 'https://app.request.finance', embedded = false, frameTimeOriginOffset = 0, messageClock = 'receiver' } = {}) {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
	// The host announces its emulated parent; record the line instead of printing it in every test.
	const previousConsoleInfo = console.info
	const previousConsoleWarn = console.warn
	const warningLogs: string[] = []
	console.warn = (...values: unknown[]) => { warningLogs.push(values.map(String).join(' ')) }
	const infoLogs: string[] = []
	console.info = (...values: unknown[]) => { infoLogs.push(values.map(String).join(' ')) }
	const fakeWindow = new EventTarget()
	let disposed = false
	const scheduledTimeouts: { readonly handler: TimerHandler, readonly delay: number | undefined, readonly args: readonly unknown[], cleared: boolean }[] = []
	const activeTimeouts = () => scheduledTimeouts.filter(({ cleared }) => !cleared).map(({ delay }) => delay)
	const fireTimeouts = (delay: number) => {
		for (const timeout of scheduledTimeouts) {
			if (timeout.cleared || timeout.delay !== delay) continue
			timeout.cleared = true
			if (typeof timeout.handler === 'function') timeout.handler.apply(fakeWindow, timeout.args)
		}
	}
	const framePort = new MessageChannel().port1
	// A real iframe initially points back to its containing page, so replacing that page's parent can create an ancestor cycle.
	Object.defineProperty(framePort, 'performance', { value: { timeOrigin: performance.timeOrigin + frameTimeOriginOffset } })
	Object.defineProperty(framePort, 'parent', { configurable: true, value: fakeWindow })
	// Model native Window.postMessage: preserve the sending window and dispatch on the receiving frame.
	const emitParentMessage = (data: unknown, messageOrigin = origin, source: EventTarget = fakeWindow, posted = performance.now()) => {
		const event = new Event('message')
		Object.defineProperties(event, { data: { value: data }, origin: { value: messageOrigin }, source: { value: source }, timeStamp: { value: posted - (messageClock === 'receiver' ? frameTimeOriginOffset : 0) } })
		framePort.dispatchEvent(event)
	}
	Object.defineProperty(framePort, 'postMessage', { configurable: true, writable: true, value: (data: unknown, targetOrigin = '/') => {
		if (targetOrigin !== '*' && targetOrigin !== '/' && targetOrigin !== origin) return
		const posted = performance.now()
		queueMicrotask(() => { if (!disposed) emitParentMessage(data, origin, fakeWindow, posted) })
	} })
	let appended = false
	const frame = {
		style: { display: '' },
		remove: () => { appended = false },
		setAttribute: (_name: string, _value: string) => undefined,
		tabIndex: 0,
		contentWindow: framePort,
	}
	const emitMessage = (data: unknown, messageOrigin = origin, source: EventTarget = fakeWindow) => {
		const event = new Event('message')
		Object.defineProperties(event, {
			data: { value: data },
			origin: { value: messageOrigin },
			source: { value: source },
		})
		fakeWindow.dispatchEvent(event)
	}
	const postMessage = (data: unknown, targetOrigin: string) => {
		assert.equal(targetOrigin, origin)
		queueMicrotask(() => { if (!disposed) emitMessage(data) })
	}
	const parent = embedded ? new EventTarget() : fakeWindow
	Object.defineProperties(fakeWindow, {
		crypto: { value: crypto },
		top: { value: parent },
		self: { value: fakeWindow },
		parent: { value: parent, configurable: true },
		location: { value: { origin } },
		performance: { value: performance },
		postMessage: { value: postMessage },
		setTimeout: { configurable: true, writable: true, value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
			scheduledTimeouts.push({ handler, delay, args, cleared: false })
			return scheduledTimeouts.length
		} },
		clearTimeout: { configurable: true, writable: true, value: (id: number) => {
			const timeout = scheduledTimeouts[id - 1]
			if (timeout !== undefined) timeout.cleared = true
		} },
	})
	Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
	Object.defineProperty(globalThis, 'document', { configurable: true, value: {
		documentElement: { append: () => { appended = true } },
		createElement: (tag: string) => {
			assert.equal(tag, 'iframe')
			return frame
		},
	} })
	return {
		fakeWindow, framePort, origin, emitMessage, emitParentMessage, activeTimeouts, fireTimeouts, postMessage,
		frameWasAppended: () => appended,
		infoLogs,
		warningLogs,
		restoreGlobals: () => {
			disposed = true
			console.info = previousConsoleInfo
			console.warn = previousConsoleWarn
			framePort.close()
			if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
			else Object.defineProperty(globalThis, 'window', previousWindow)
			if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
			else Object.defineProperty(globalThis, 'document', previousDocument)
		},
	}
}
