import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { MessageToPopup, PopupMessage } from '../../app/ts/types/interceptor-messages.js'
import { flushMicrotasks } from '../harness/async.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, hasClass, isDisabled } from './domQueries.js'
import { createAccessRequestFixture, createChangeChainMessage } from './popupAsyncActionTestHarness.js'
import { getMessageMethod } from './runtimeMessageMatchers.js'
import { createRuntimeMessagingInstaller } from './runtimeMessagingTestHarness.js'

// The app modules are imported after the browser globals exist, as in the extension; each test then installs its own mock.
installBrowserMock()
const installRuntimeMessaging = createRuntimeMessagingInstaller()

async function loadModules() {
	return {
		...await import('../../app/ts/components/pages/AddNewAddress.js'),
		...await import('../../app/ts/components/pages/ChangeChain.js'),
		...await import('../../app/ts/components/pages/InterceptorAccess.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GovernanceVoteVisualizer.js'),
		...await import('../../app/ts/components/simulationExplaining/customExplainers/GnosisSafeVisualizer.js'),
		...await import('../../app/ts/components/pages/PersonalSign.js'),
	}
}

const modulesPromise = loadModules()

describe('access request and chain change actions wait for background replies', () => {
	test('keeps access approval pending across parent re-renders until the background reply settles', async () => {
		const modules = await modulesPromise
		installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<void>()
		let approveCount = 0
		const request = createAccessRequestFixture()
		const props = {
			pendingAccessRequests: [request],
			renameAddressCallBack: () => undefined,
			changeActiveAddress: () => undefined,
			refreshActiveAddress: async () => undefined,
			approve: async () => {
				approveCount += 1
				await deferredReply.promise
			},
			reject: async () => undefined,
			informationChangedRecently: signal(false),
		}

		await act(() => {
			render(h(modules.AccessRequests, props), dom.document.body)
		})
		const approveButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Grant Access'))
		const rejectButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Deny Access'))
		if (approveButton === undefined) throw new Error('Expected access approval button to render')
		if (rejectButton === undefined) throw new Error('Expected access rejection button to render')

		await act(async () => {
			await clickElement(approveButton)
			await flushMicrotasks()
			render(h(modules.AccessRequests, props), dom.document.body)
		})

		assert.equal(approveCount, 1)
		assert.equal(isDisabled(approveButton), true)
		assert.equal(isDisabled(rejectButton), true)
		assert.equal(approveButton.textContent.includes('Granting access...'), true)

		await act(async () => {
			deferredReply.resolve()
			await deferredReply.promise
			await flushMicrotasks()
		})

		assert.equal(isDisabled(approveButton), false)
		dom.restore()
	})

	test('does not transfer pending access state when the first request is removed', async () => {
		const modules = await modulesPromise
		installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<void>()
		const firstRequest = { ...createAccessRequestFixture(), accessRequestId: 'first-request' }
		const secondRequest = { ...createAccessRequestFixture(), accessRequestId: 'second-request', website: { websiteOrigin: 'https://second.test', icon: undefined, title: 'Second' } }
		const props = {
			pendingAccessRequests: [firstRequest, secondRequest],
			renameAddressCallBack: () => undefined,
			changeActiveAddress: () => undefined,
			refreshActiveAddress: async () => undefined,
			approve: async (accessRequestId: string) => {
				if (accessRequestId === firstRequest.accessRequestId) await deferredReply.promise
			},
			reject: async () => undefined,
			informationChangedRecently: signal(false),
		}

		await act(() => {
			render(h(modules.AccessRequests, props), dom.document.body)
		})
		const firstApproveButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Grant Access'))
		if (firstApproveButton === undefined) throw new Error('Expected the first access approval button to render')

		await act(async () => {
			await clickElement(firstApproveButton)
			await flushMicrotasks()
			render(h(modules.AccessRequests, { ...props, pendingAccessRequests: [secondRequest] }), dom.document.body)
		})

		const remainingApproveButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Grant Access'))
		if (remainingApproveButton === undefined) throw new Error('Expected the remaining access approval button to render')
		assert.equal(isDisabled(remainingApproveButton), false)
		assert.equal(remainingApproveButton.textContent.includes('Granting access...'), false)

		deferredReply.resolve()
		await deferredReply.promise
		render(undefined, dom.document.body)
		dom.restore()
	})

	test('keeps the access request id when selecting an address closes the modal', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const currentAddress = 0x1111111111111111111111111111111111111111n
		const selectedAddress = 0x2222222222222222222222222222222222222222n
		const request = {
			...createAccessRequestFixture(),
			requestAccessToAddress: {
				type: 'contact' as const,
				name: 'Current address',
				address: currentAddress,
				askForAddressAccess: true,
				useAsActiveAddress: true,
				entrySource: 'User' as const,
			},
			originalRequestAccessToAddress: {
				type: 'contact' as const,
				name: 'Current address',
				address: currentAddress,
				askForAddressAccess: true,
				useAsActiveAddress: true,
				entrySource: 'User' as const,
			},
			simulationMode: true,
		}
		const selectedAddressEntry = {
			type: 'contact' as const,
			name: 'Selected address',
			address: selectedAddress,
			askForAddressAccess: true,
			useAsActiveAddress: true,
			entrySource: 'User' as const,
		}
		let addressChangeMessage: unknown
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_interceptorAccessChangeAddress') addressChangeMessage = message
			return undefined
		}

		await act(async () => {
			render(h(modules.InterceptorAccess, {}), dom.document.body)
			await flushMicrotasks()
		})
		await act(async () => {
			await messaging.dispatchAndAwaitListeners(MessageToPopup.serialize({
				role: 'all',
				method: 'popup_interceptorAccessDialog',
				data: { activeAddresses: [selectedAddressEntry], pendingAccessRequests: [request] },
			}))
		})

		const changeButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.trim() === 'Change')
		if (changeButton === undefined) throw new Error('Expected the change-address button to render')
		await act(async () => { await clickElement(changeButton) })

		const selectedAddressCard = collectElements(dom.document.body, 'div').find((element) =>
			hasClass(element, 'card')
			&& element.textContent.includes('Selected address') === true
		)
		if (selectedAddressCard === undefined) throw new Error('Expected the selected address card to render')
		await act(async () => {
			await clickElement(selectedAddressCard)
			await flushMicrotasks()
		})

		const parsedAddressChangeMessage = PopupMessage.parse(addressChangeMessage)
		assert.deepEqual(parsedAddressChangeMessage, {
			method: 'popup_interceptorAccessChangeAddress',
			data: {
				socket: request.socket,
				website: request.website,
				requestAccessToAddress: currentAddress,
				newActiveAddress: selectedAddress,
				accessRequestId: request.accessRequestId,
			},
		})

		render(undefined, dom.document.body)
		dom.restore()
	})

	test('sends the change-chain request and resolves once a background reply arrives', async () => {
		const modules = await modulesPromise
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<unknown>()
		let chainDialogRequest: unknown
		messaging.browserMock.handlers.runtimeMessage = async (message) => {
			if (getMessageMethod(message) === 'popup_changeChainDialog') {
				chainDialogRequest = message
				return deferredReply.promise
			}
			return undefined
		}

		await act(() => {
			render(h(modules.ChangeChain, {}), dom.document.body)
		})

		await act(async () => {
			await messaging.dispatchAndAwaitListeners(createChangeChainMessage())
		})

		const changeChainButton = collectElements(dom.document.body, 'button').find((button) => button.textContent.includes('Change chain'))
		if (changeChainButton === undefined) throw new Error('Expected chain change confirm button to render')

			await act(async () => {
				await clickElement(changeChainButton)
				await flushMicrotasks()
			})

			assert.equal(chainDialogRequest === undefined, false)
			assert.equal(isDisabled(changeChainButton), true)

			await act(async () => {
				deferredReply.resolve(undefined)
				await deferredReply.promise
				await flushMicrotasks()
			})

			assert.equal(isDisabled(changeChainButton), false)
			assert.equal(changeChainButton.textContent.includes('Change chain'), true)
			assert.equal(chainDialogRequest === undefined, false)
			dom.restore()
		})
})
