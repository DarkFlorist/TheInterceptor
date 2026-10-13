import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { getSimulationStackTargetHash } from '../../app/ts/utils/simulationStackTargets.js'
import { replaceProperty } from '../harness/globals.js'
import { installDomMock } from './domMock.js'
import { clickElement } from './domQueries.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'
import { countTextOccurrences, createStackHomePageUpdate, deliverHomePageUpdate, findElementById, getHeadersContainingText, installQueuedAnimationFrames } from './simulationVisualizerTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('stack visualizer transaction cards and target hash navigation', () => {
	test('stack visualizer transaction cards collapse and reopen independently', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(18, 1, 'Stack tab', [1n, 2n]))
			})

			const transactionHeaders = getHeadersContainingText(dom.document.body, 'Pending transaction')
			assert.equal(transactionHeaders.length, 2)
			const firstHeader = transactionHeaders[0]
			const secondHeader = transactionHeaders[1]
			if (firstHeader === undefined || secondHeader === undefined) throw new Error('Expected two transaction headers')
			assert.equal(String(firstHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent, 'Original request'), 2)

			await act(async () => {
				await clickElement(firstHeader)
			})
			assert.equal(String(firstHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(String(secondHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent, 'Original request'), 1)
			assert.equal(dom.document.body.textContent.includes('Simulate delay'), false)

			await act(async () => {
				await clickElement(secondHeader)
			})
			assert.equal(String(firstHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(String(secondHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(countTextOccurrences(dom.document.body.textContent, 'Original request'), 0)
			assert.equal(dom.document.body.textContent.includes('Simulate delay'), false)

			await act(async () => {
				await clickElement(firstHeader)
			})
			assert.equal(String(firstHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute('aria-expanded')), 'false')
			assert.equal(countTextOccurrences(dom.document.body.textContent, 'Original request'), 1)

			await act(async () => {
				await clickElement(secondHeader)
			})
			assert.equal(String(firstHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(String(secondHeader.getAttribute('aria-expanded')), 'true')
			assert.equal(countTextOccurrences(dom.document.body.textContent, 'Original request'), 2)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer target hash no-ops when the target element cannot scroll', async () => {
		const dom = installDomMock()
		const { flushAnimationFrames, restore: restoreAnimationFrames } = installQueuedAnimationFrames()
		const messaging = installRuntimeMessaging()
		replaceProperty(globalThis.window, 'location', { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'no-scroll') })
		replaceProperty(dom.document, 'getElementById', (id: string) => findElementById(dom.document.body, id) ?? null)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(14, 1, 'Stack tab'))
			})
			await act(() => {
				flushAnimationFrames()
			})

			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute('class')?.includes('simulation-stack-row--highlighted'), false)
		} finally {
			restoreAnimationFrames()
			dom.restore()
		}
	})

	test('stack visualizer target hash no-ops when target lookup is unavailable', async () => {
		const dom = installDomMock()
		const { flushAnimationFrames, restore: restoreAnimationFrames } = installQueuedAnimationFrames()
		const messaging = installRuntimeMessaging()
		replaceProperty(globalThis.window, 'location', { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'no-lookup') })
		replaceProperty(dom.document, 'getElementById', undefined)
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(16, 1, 'Stack tab'))
			})
			await act(() => {
				flushAnimationFrames()
			})

			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute('class')?.includes('simulation-stack-row--highlighted'), false)
		} finally {
			restoreAnimationFrames()
			dom.restore()
		}
	})

	test('stack visualizer target hash scrolls to and highlights the matching row', async () => {
		const dom = installDomMock()
		const { flushAnimationFrames, restore: restoreAnimationFrames } = installQueuedAnimationFrames()
		const messaging = installRuntimeMessaging()
		const scrollCalls: ScrollIntoViewOptions[] = []
		replaceProperty(globalThis.window, 'location', { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'scroll') })
		replaceProperty(dom.document, 'getElementById', (id: string) => {
				const element = findElementById(dom.document.body, id)
				if (element === undefined) return null
				element.scrollIntoView = (options?: ScrollIntoViewOptions) => {
					if (options !== undefined) scrollCalls.push(options)
				}
				return element
			})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(15, 1, 'Stack tab'))
			})
			const targetHeader = getHeadersContainingText(dom.document.body, 'Pending transaction')[0]
			if (targetHeader === undefined) throw new Error('Expected target transaction header')
			await act(async () => {
				await clickElement(targetHeader)
			})
			assert.equal(String(targetHeader.getAttribute('aria-expanded')), 'false')
			await act(() => {
				flushAnimationFrames()
			})

			assert.deepStrictEqual(scrollCalls.at(-1), { behavior: 'smooth', block: 'center' })
			const targetRow = findElementById(dom.document.body, 'simulation-stack-transaction-0x1')
			assert.ok(targetRow)
			assert.equal(targetRow.getAttribute('class')?.includes('simulation-stack-row--highlighted'), true)
			assert.equal(String(targetHeader.getAttribute('aria-expanded')), 'true')
		} finally {
			restoreAnimationFrames()
			dom.restore()
		}
	})

	test('stack visualizer target hash does not replay after same-hash updates', async () => {
		const dom = installDomMock()
		const { flushAnimationFrames, restore: restoreAnimationFrames } = installQueuedAnimationFrames()
		const messaging = installRuntimeMessaging()
		const scrollCalls: ScrollIntoViewOptions[] = []
		replaceProperty(globalThis.window, 'location', { hash: getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'retry') })
		replaceProperty(dom.document, 'getElementById', (id: string) => {
				const element = findElementById(dom.document.body, id)
				if (element === undefined) return null
				element.scrollIntoView = (options?: ScrollIntoViewOptions) => {
					if (options !== undefined) scrollCalls.push(options)
				}
				return element
			})
		try {
			await act(() => {
				render(h(SimulationStackPage, {}), dom.document.body)
			})

			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 0)

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(17, 1, 'Stack tab'))
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 1)

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(17, 2, 'Stack tab refresh'))
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 1)

			globalThis.window.location.hash = getSimulationStackTargetHash({ type: 'Transaction', transactionIdentifier: 1n }, 'retry-again')
			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(17, 3, 'Stack tab retarget'))
			})
			await act(() => {
				flushAnimationFrames()
			})
			assert.equal(scrollCalls.length, 2)
		} finally {
			restoreAnimationFrames()
			dom.restore()
		}
	})
})
