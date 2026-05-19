import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { installDomMock } from './domMock.js'

const storageState: Record<string, unknown> = {}
let runtimeSendMessage: (message: unknown) => Promise<unknown> = async (_message: unknown) => undefined
let localSetBehavior = async (items: Record<string, unknown>) => {
	Object.assign(storageState, items)
}
const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
const visualizerTypesModulePath = '../../app/ts/types/visualizer-types.js'
const popupMessageHandlersModulePath = '../../app/ts/background/popupMessageHandlers.js'
const importSimulationStackModulePath = '../../app/ts/components/pages/ImportSimulationStack.js'
const { InterceptorSimulationExport } = await import(visualizerTypesModulePath)

function installBrowser() {
	const browserMock = {
		runtime: {
			lastError: null,
			getManifest: () => ({ manifest_version: 3 }),
			sendMessage: async (message: unknown) => await runtimeSendMessage(message),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					await localSetBehavior(items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}
	defineGlobal('browser', browserMock)
	defineGlobal('chrome', { runtime: { id: 'test-extension' } })
	defineGlobal('indexedDB', undefined)
}

installBrowser()

async function loadModules() {
	return {
		...await import(popupMessageHandlersModulePath),
		...await import(importSimulationStackModulePath),
	}
}

const modulesPromise = loadModules()

const exportPayload = {
	name: 'Interceptor Simulation Export' as const,
	version: '1.0.0' as const,
	eth_simulateV1: {
		method: 'eth_simulateV1' as const,
		params: [{
			blockStateCalls: [],
			traceTransfers: true,
			validation: true,
		}, 'latest' as const],
	},
	interceptorSimulateStack: {
		operations: [{
			type: 'TimeManipulation' as const,
			blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 3n, deltaUnit: 'Seconds' as const },
		}],
	},
}

const exportString = JSON.stringify(InterceptorSimulationExport.serialize(exportPayload))

function resetEnvironment() {
	for (const key of Object.keys(storageState)) delete storageState[key]
	runtimeSendMessage = async () => undefined
	localSetBehavior = async (items: Record<string, unknown>) => {
		Object.assign(storageState, items)
	}
	defineGlobal('indexedDB', undefined)
}

type ClickableElement = { l?: Record<string, (event: { currentTarget: ClickableElement }) => unknown> }
type ElementTreeNode = ClickableElement & { tagName?: string, childNodes?: readonly ElementTreeNode[], textContent?: string }

function collectElements(node: ElementTreeNode | undefined, tagName: string, results: ElementTreeNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

async function clickElement(element: ClickableElement) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element })
}

describe('import simulation stack', () => {
	test('returns a typed failure reply when stack persistence fails', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		localSetBehavior = async (items: Record<string, unknown>) => {
			if ('interceptorTransactionStack' in items) throw new Error('Resource::kQuotaBytes quota exceeded')
			Object.assign(storageState, items)
		}

		const reply = await modules.importSimulationStack(undefined, undefined, { method: 'popup_importSimulationStack', data: exportPayload })

		assert.equal(reply.type, 'ImportSimulationStackReply')
		assert.equal(reply.ok, false)
		assert.match(reply.message, /quota/i)
		assert.match(reply.message, /simulation stack/i)
	})

	test('keeps the modal open and shows the returned import error', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		let closeCount = 0
		runtimeSendMessage = async () => ({ type: 'ImportSimulationStackReply', ok: false, message: 'Quota exceeded while saving the imported stack.' })

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
		})

		assert.equal(closeCount, 0)
		assert.match(dom.document.body.textContent, /Quota exceeded while saving the imported stack\./)
		dom.restore()
	})

	test('closes the modal after a successful import reply', async () => {
		const modules = await modulesPromise
		resetEnvironment()
		const dom = installDomMock()
		let closeCount = 0
		runtimeSendMessage = async () => ({ type: 'ImportSimulationStackReply', ok: true })

		await act(() => {
			render(h(modules.ImportSimulationStack, {
				close: () => { closeCount += 1 },
				simulationInput: signal(exportString),
			}), dom.document.body)
		})

		const buttons = collectElements(dom.document.body, 'button')
		const importButton = buttons.find((button) => button.textContent?.includes('Import'))
		assert.ok(importButton)

		await act(async () => {
			await clickElement(importButton)
		})

		assert.equal(closeCount, 1)
		dom.restore()
	})
})
