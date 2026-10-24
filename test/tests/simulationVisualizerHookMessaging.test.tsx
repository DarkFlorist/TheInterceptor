import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { replaceProperty } from '../harness/globals.js'
import { installDomMock } from './domMock.js'
import { hasMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'
import { createHomePageUpdate, createStackHomePageUpdate, CrossTabStackVisualizerHookProbe, deliverHomePageUpdate, MainPopupSimulationStateProbe, StackVisualizerHookProbe } from './simulationVisualizerTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

describe('stack visualizer entrypoint and popup simulation-data hooks', () => {
	test('stack visualizer entrypoint wraps the page in Hint for toolbar feedback', async () => {
		const source = await Bun.file('app/ts/simulationStack.ts').text()

		assert.match(source, /import Hint from '\.\/components\/subcomponents\/Hint\.js'/)
		assert.match(source, /preact\.createElement\(Hint,\s*\{\s*children:\s*preact\.createElement\(SimulationStackPage,\s*\{\}\)\s*\}\)/)
	})

	test('stack visualizer entrypoint clears the shell loading placeholder before rendering', async () => {
		const dom = installDomMock()
		installRuntimeMessaging()
		const root = dom.document.createElement('div')
		root.setAttribute('id', 'simulation-stack-root')
		root.textContent = 'Loading...'
		dom.document.body.appendChild(root)
		// The entrypoint looks its mount point up by id, which the DOM mock does not implement; getElementById reports a missing element with null.
		replaceProperty(dom.document, 'getElementById', (id: string) => id === 'simulation-stack-root' ? root : null)
		try {
			await act(async () => {
				await import(`../../app/ts/simulationStack.ts?entrypoint-test=${ crypto.randomUUID() }`)
			})
			assert.equal(root.textContent.includes('Loading...'), false)
		} finally {
			await act(() => {
				render(undefined, root)
			})
			dom.restore()
		}
	})

	test('Hint resolves copied feedback from nested toolbar click targets', async () => {
		const source = await Bun.file('app/ts/components/subcomponents/Hint.tsx').text()

		assert.match(source, /target\.closest\(`\[\$\{ attribute \}\]`\)/)
		assert.match(source, /getHintElement\(event\.target,\s*copyAttribute\)/)
	})

	test('stack visualizer hook answers the visualizer-open probe but not the main-popup probe', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(StackVisualizerHookProbe, {}), dom.document.body)
			})

			assert.equal(messaging.sentMessages.some((message) => PopupMessage.safeParse(message).success && hasMessageMethod(message, 'popup_requestSettingsChangeStatus')), false)

			const visualizerReply = messaging.dispatchAndCaptureReply({ method: 'popup_isSimulationVisualizerOpen' })
			assert.equal(visualizerReply.keptChannelOpen, true)
			assert.deepEqual(visualizerReply.response, { method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } })

			const mainPopupReply = messaging.dispatchAndCaptureReply({ method: 'popup_isMainPopupWindowOpen' })
			assert.equal(mainPopupReply.keptChannelOpen, false)
			assert.equal(mainPopupReply.response, undefined)
		} finally {
			dom.restore()
		}
	})

	test('stack visualizer hook accepts updates from a different tab id', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(CrossTabStackVisualizerHookProbe, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createHomePageUpdate(10, 1, 'First tab'))
			})
			assert.equal(dom.document.body.textContent.includes('First tab'), true)

			await act(() => {
				deliverHomePageUpdate(messaging, createHomePageUpdate(11, 2, 'Second tab'))
			})
			assert.equal(dom.document.body.textContent.includes('Second tab'), true)
			assert.equal(dom.document.body.textContent.includes('First tab'), false)
		} finally {
			dom.restore()
		}
	})

	test('main popup hook keeps Safe simulation results without a simulation-mode address', async () => {
		const dom = installDomMock()
		const messaging = installRuntimeMessaging()
		try {
			await act(() => {
				render(h(MainPopupSimulationStateProbe, {}), dom.document.body)
			})

			await act(() => {
				deliverHomePageUpdate(messaging, createStackHomePageUpdate(12, 1, 'Safe stack'))
			})

			assert.equal(dom.document.body.textContent, 'simulated')
		} finally {
			dom.restore()
		}
	})
})
