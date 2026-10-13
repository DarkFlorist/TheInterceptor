// Clipboard replacements for popup tests: a navigator.clipboard that records copied text, and paste events that pass `instanceof ClipboardEvent`.
import { replaceGlobal } from '../harness/globals.js'

export function installClipboardMock() {
	const copiedText: string[] = []
	const restore = replaceGlobal('navigator', {
		clipboard: {
			writeText: async (text: string) => { copiedText.push(text) },
		},
	})
	return { copiedText, restore }
}

// Installs a ClipboardEvent stand-in for `event instanceof ClipboardEvent` checks and creates paste events that pass them.
export function installClipboardEventMock() {
	const pasteEvents = new WeakSet<object>()
	const restore = replaceGlobal('ClipboardEvent', { [Symbol.hasInstance]: (value: unknown) => typeof value === 'object' && value !== null && pasteEvents.has(value) })
	return {
		createPasteEvent: (text: string) => {
			const pasteEvent = Object.assign(new Event('paste'), { clipboardData: { getData: (type: string) => type === 'text' ? text : '' } })
			pasteEvents.add(pasteEvent)
			return pasteEvent
		},
		restore,
	}
}
