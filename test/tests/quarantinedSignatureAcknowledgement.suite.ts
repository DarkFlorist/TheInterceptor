import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SignMessageParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import { TransactionConfirmation } from '../../app/ts/types/interceptor-messages.js'
import { activeAddress, addressString, browserMock, createWebsitePort, isRecord, modules, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { clickRenderedElement, findRenderedElement, installDomMock, type RenderedTreeNode } from './domMock.js'

const ACKNOWLEDGEMENT_TEXT = 'I understand that there are issues with this signature request'

// The active test chain is 1337, so a domain bound to chain 1 is quarantined as a cross-chain request.
const crossChainTypedDataRequest = SignMessageParams.parse({
	method: 'eth_signTypedData_v4',
	params: [addressString(activeAddress), JSON.stringify({
		types: {
			EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
			Mail: [{ name: 'contents', type: 'string' }],
		},
		primaryType: 'Mail',
		domain: { name: 'Cross-chain test', chainId: 1 },
		message: { contents: 'hello' },
	})],
})

function createApprovedConnections(postedMessages: unknown[]) {
	const socket = uniqueRequestIdentifier.requestSocket
	return new Map([[socket.tabId, { connections: {
		[modules.websiteSocketToString(socket)]: {
			port: createWebsitePort(socket, 0, postedMessages),
			socket,
			websiteOrigin: 'https://example.com',
			approved: true,
			approvedAddress: activeAddress,
			wantsToConnect: true,
		},
	} }]])
}

async function openQuarantinedSignatureRequest(simulationMode: boolean, websiteTabConnections: ReturnType<typeof createApprovedConnections>) {
	await browser.storage.local.set({ simulationMode })
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...crossChainTypedDataRequest },
		{ kind: 'message', parameters: crossChainTypedDataRequest },
		simulationMode,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })
	const [pendingRequest] = await modules.getPendingTransactionsAndMessages()
	if (pendingRequest?.type !== 'SignableMessage' || pendingRequest.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected a prepared signature request')
	assert.equal(pendingRequest.visualizedPersonalSignRequest.quarantine, true)
	assert.equal(pendingRequest.visualizedPersonalSignRequest.isValidMessage, true)
	return browserMock.sentMessages.findLast((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
}

// Renders the real confirmation page against the shared harness: popup-bound runtime messages are delivered to the page's listeners, and the page's own messages are captured instead of reaching the background.
async function renderConfirmationPage(popupUpdate: unknown) {
	const { ConfirmTransaction } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
	const listeners: ((message: unknown) => unknown)[] = []
	const pageMessages: unknown[] = []
	const runtime = browser.runtime
	const originalOnMessage = runtime.onMessage
	const originalSendMessage = runtime.sendMessage
	const originalGetCurrentWindow = browser.windows.getCurrent
	Reflect.set(runtime, 'onMessage', {
		addListener: (listener: (message: unknown) => unknown) => { listeners.push(listener) },
		removeListener: (listener: (message: unknown) => unknown) => { listeners.splice(listeners.indexOf(listener), 1) },
	})
	Reflect.set(runtime, 'sendMessage', async (message: unknown) => {
		pageMessages.push(message)
		if (isRecord(message) && message.method === 'popup_readyAndListening') return { method: 'popup_readyAndListening', data: { popupOrTabId: { type: 'popup', id: 1 } } }
		return undefined
	})
	Reflect.set(browser.windows, 'getCurrent', async () => ({ id: 1 }))
	const dom = installDomMock()
	await act(() => { render(h(ConfirmTransaction, {}), dom.document.body) })
	await act(() => { for (const listener of [...listeners]) listener(popupUpdate) })
	const findAcknowledgement = () => {
		const label = findRenderedElement(dom.document.body, (node) => node.tagName === 'LABEL' && node.textContent?.includes(ACKNOWLEDGEMENT_TEXT) === true)
		return label === undefined ? undefined : findRenderedElement(label, (node) => node.tagName === 'INPUT')
	}
	const findConfirmButton = () => findRenderedElement(dom.document.body, (node) => {
		if (node.tagName !== 'BUTTON' || node.textContent?.includes('Reject') === true || !isRecord(node) || !isRecord(node.attributes)) return false
		return typeof node.attributes.class === 'string' && node.attributes.class.includes('dialog-action-button')
	})
	const isConfirmDisabled = () => {
		const confirmButton = findConfirmButton()
		if (!isRecord(confirmButton) || !isRecord(confirmButton.attributes)) throw new Error('missing confirm button')
		return confirmButton.attributes.disabled === true
	}
	const tickAcknowledgement = async (checkbox: RenderedTreeNode) => {
		const inputHandler = checkbox.l === undefined ? undefined : Object.entries(checkbox.l).find(([key]) => key.toLowerCase().startsWith('input'))?.[1]
		if (inputHandler === undefined) throw new Error(`missing acknowledgement input handler (${ Object.keys(checkbox.l ?? {}).join(', ') })`)
		// The checkbox handler checks for an HTMLInputElement, which the DOM mock does not define.
		Object.defineProperty(globalThis, 'HTMLInputElement', { value: globalThis.Element, configurable: true, writable: true })
		try {
			await act(() => { inputHandler({ target: Object.assign(checkbox, { checked: true }) }) })
		} finally {
			Reflect.deleteProperty(globalThis, 'HTMLInputElement')
		}
	}
	const clickConfirm = async () => {
		const confirmButton = findConfirmButton()
		if (confirmButton === undefined) throw new Error('missing confirm button')
		await act(async () => { await clickRenderedElement(confirmButton) })
		const confirmation = pageMessages.find((message) => isRecord(message) && message.method === 'popup_confirmDialog')
		if (confirmation === undefined) throw new Error('The page did not send an acceptance')
		return TransactionConfirmation.parse(confirmation)
	}
	const cleanup = async () => {
		await act(() => { render(null, dom.document.body) })
		dom.restore()
		Reflect.set(runtime, 'onMessage', originalOnMessage)
		Reflect.set(runtime, 'sendMessage', originalSendMessage)
		Reflect.set(browser.windows, 'getCurrent', originalGetCurrentWindow)
	}
	return { findAcknowledgement, isConfirmDisabled, tickAcknowledgement, clickConfirm, cleanup }
}

test('a quarantined cross-chain typed-data request can be acknowledged and simulated in simulation mode', async () => {
	const postedMessages: unknown[] = []
	const websiteTabConnections = createApprovedConnections(postedMessages)
	const page = await renderConfirmationPage(await openQuarantinedSignatureRequest(true, websiteTabConnections))
	try {
		const acknowledgement = page.findAcknowledgement()
		if (acknowledgement === undefined) throw new Error('The simulation-mode acknowledgement is missing')
		assert.equal(page.isConfirmDisabled(), true)
		await page.tickAcknowledgement(acknowledgement)
		assert.equal(page.isConfirmDisabled(), false)
		const confirmation = await page.clickConfirm()
		assert.equal(confirmation.data.action === 'accept' ? confirmation.data.forceSend : undefined, true)
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, confirmation), true)
		const simulatedSignature = postedMessages.find((message) => isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4')
		assert.equal(isRecord(simulatedSignature) && typeof simulatedSignature.result === 'string', true)
		assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	} finally {
		await page.cleanup()
	}
})

test('signing mode still requires the acknowledgement for a quarantined typed-data request before forwarding it', async () => {
	const postedMessages: unknown[] = []
	const websiteTabConnections = createApprovedConnections(postedMessages)
	const page = await renderConfirmationPage(await openQuarantinedSignatureRequest(false, websiteTabConnections))
	try {
		const acknowledgement = page.findAcknowledgement()
		if (acknowledgement === undefined) throw new Error('The signing-mode acknowledgement is missing')
		assert.equal(page.isConfirmDisabled(), true)
		await assert.rejects(modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier, forceSend: false },
		}), /Quarantined signature requests require explicit user acknowledgement/u)
		await page.tickAcknowledgement(acknowledgement)
		assert.equal(page.isConfirmDisabled(), false)
		const confirmation = await page.clickConfirm()
		assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, confirmation), true)
		const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
		assert.equal(isRecord(signerRequest) && signerRequest.method === 'eth_signTypedData_v4', true)
	} finally {
		await page.cleanup()
	}
})
