import * as assert from 'assert'

export function createSafeHostHarness({ origin = 'https://app.request.finance', embedded = false } = {}) {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
	const fakeWindow = new EventTarget()
	const scheduledTimeouts: { readonly handler: TimerHandler, readonly delay: number | undefined, readonly args: readonly unknown[], cleared: boolean }[] = []
	const activeTimeouts = () => scheduledTimeouts.filter(({ cleared }) => !cleared).map(({ delay }) => delay)
	const fireTimeouts = (delay: number) => {
		for (const timeout of scheduledTimeouts) {
			if (timeout.cleared || timeout.delay !== delay) continue
			timeout.cleared = true
			if (typeof timeout.handler === 'function') timeout.handler(...timeout.args)
		}
	}
	const framePort = new MessageChannel().port1
	const frame = {
		style: { display: '' },
		setAttribute: (_name: string, _value: string) => undefined,
		tabIndex: 0,
		contentWindow: framePort,
	}
	let appended = false
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
		queueMicrotask(() => emitMessage(data))
	}
	const parent = embedded ? new EventTarget() : fakeWindow
	Object.defineProperties(fakeWindow, {
		crypto: { value: crypto },
		top: { value: parent },
		self: { value: fakeWindow },
		parent: { value: parent, configurable: true },
		location: { value: { origin } },
		postMessage: { value: postMessage },
		setTimeout: { configurable: true, value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
			scheduledTimeouts.push({ handler, delay, args, cleared: false })
			return scheduledTimeouts.length
		} },
		clearTimeout: { value: (id: number) => {
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
		fakeWindow, framePort, origin, emitMessage, activeTimeouts, fireTimeouts, postMessage,
		frameWasAppended: () => appended,
		restoreGlobals: () => {
			framePort.close()
			if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
			else Object.defineProperty(globalThis, 'window', previousWindow)
			if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
			else Object.defineProperty(globalThis, 'document', previousDocument)
		},
	}
}
