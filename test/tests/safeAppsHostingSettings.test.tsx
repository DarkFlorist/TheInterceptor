import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeAppsHostingSettings } from '../../app/ts/components/subcomponents/SafeAppsHostingSettings.js'
import { PopupReplyOption } from '../../app/ts/types/interceptor-reply-messages.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly tagName?: string
	readonly textContent?: string
	readonly hasAttribute?: (name: string) => boolean
	readonly l?: Record<string, (event: { currentTarget: TestNode }) => unknown>
}

function findElement(node: TestNode, tagName: string, text?: string): TestNode | undefined {
	if (node.tagName === tagName && (text === undefined || node.textContent?.includes(text))) return node
	for (const child of node.childNodes ?? []) {
		const found = findElement(child, tagName, text)
		if (found !== undefined) return found
	}
	return undefined
}

function clickElement(element: TestNode | undefined) {
	const click = Object.entries(element?.l ?? {}).find(([event]) => event.startsWith('Click'))?.[1]
	if (click === undefined || element === undefined) throw new Error('Expected a clickable element')
	click({ currentTarget: element })
}

test('Safe Apps website edits require compatibility to be enabled', async () => {
	const dom = installDomMock()
	try {
		await act(() => { render(h(SafeAppsHostingSettings, { enabled: false, origins: ['https://host.example'] }), dom.document.body) })
		for (const text of ['Authorize and reload open tab', 'Remove', 'Add website']) {
			assert.equal(findElement(dom.document.body, 'BUTTON', text)?.hasAttribute?.('disabled'), true)
		}
		assert.equal(findElement(dom.document.body, 'INPUT')?.hasAttribute?.('disabled'), true)

		await act(() => { render(h(SafeAppsHostingSettings, { enabled: true, origins: ['https://host.example'] }), dom.document.body) })
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Authorize and reload open tab')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Remove')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'INPUT')?.hasAttribute?.('disabled'), false)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})

test('Safe Apps connection state belongs to its website and does not block website edits', async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let finishPreparation: (() => void) | undefined
	const preparation = new Promise<unknown>((resolve) => {
		finishPreparation = () => resolve(PopupReplyOption.serialize({ method: 'popup_prepareSafeApp', data: { success: true } }))
	})
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async (message: { method: string }) => {
		if (message.method === 'popup_prepareSafeApp') return await preparation
		throw new Error(`Unexpected message: ${ message.method }`)
	} } } })
	try {
		await act(() => { render(h(SafeAppsHostingSettings, { enabled: true, origins: ['https://first.example', 'https://second.example'] }), dom.document.body) })
		clickElement(findElement(dom.document.body, 'BUTTON', 'Authorize and reload open tab'))
		await act(async () => { await Promise.resolve() })
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Connecting…')?.hasAttribute?.('disabled'), true)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Authorize and reload open tab')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Remove')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Add website') !== undefined, true)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Saving…'), undefined)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Cancel connection')?.hasAttribute?.('disabled'), false)
	} finally {
		finishPreparation?.()
		await act(async () => { await preparation })
		render(null, dom.document.body)
		dom.restore()
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})

test('saving a website leaves connection buttons ready without showing their pending labels', async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let finishSave: (() => void) | undefined
	const save = new Promise<void>((resolve) => { finishSave = resolve })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async (message: { method: string }) => {
		if (message.method === 'popup_ChangeSettings') return await save
		if (message.method === 'popup_requestSettings') return undefined
		throw new Error(`Unexpected message: ${ message.method }`)
	} } } })
	try {
		await act(() => { render(h(SafeAppsHostingSettings, { enabled: true, origins: ['https://first.example', 'https://second.example'] }), dom.document.body) })
		clickElement(findElement(dom.document.body, 'BUTTON', 'Remove'))
		await act(async () => { await Promise.resolve() })
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Authorize and reload open tab')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Connecting…'), undefined)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Saving…'), undefined)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Add website')?.hasAttribute?.('disabled'), true)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Remove')?.hasAttribute?.('disabled'), true)
	} finally {
		finishSave?.()
		await act(async () => { await save })
		render(null, dom.document.body)
		dom.restore()
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
