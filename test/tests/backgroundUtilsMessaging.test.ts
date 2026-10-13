import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import * as funtypes from 'funtypes'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import { createEthereumWithGetBlockCounter, createRestoringBrowserMockInstaller } from './backgroundEthAccountsTestHarness.js'
import { withSilencedConsole } from './consoleSilence.js'

const ASYNC_RESPONSE_CLOSED_MESSAGE = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'

const installBackgroundBrowserMock = createRestoringBrowserMockInstaller()

// Every browser.runtime.sendMessage call rejects with errorMessage until a test chooses other replies through handlers.runtimeMessage.
function installBrowserMock(errorMessage: string) {
	return installBackgroundBrowserMock({ handlers: { runtimeMessage: () => { throw new Error(errorMessage) } } })
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/utils/unexpectedErrorStorage.js'),
		...await import('../../app/ts/background/background.js'),
		...await import('../../app/ts/background/popupMessageRouting.js'),
		...await import('../../app/ts/types/interceptor-reply-messages.js'),
	}
}

const homePageSettings: Settings = {
	activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	activeSigningSafeAddress: undefined,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	activeRpcNetwork: {
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://ethereum.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: '../img/ethereum.svg',
		primary: true,
		minimized: true,
	},
	simulationMode: true,
}

const ParseErrorReply = funtypes.ReadonlyObject({
	error: funtypes.ReadonlyObject({
		code: funtypes.Number,
		message: funtypes.String,
	}),
})

describe('backgroundUtils messaging', () => {
	test('ignore closed async response errors for popup fire-and-forget messages', async () => {
		const browserMock = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
		const { sendPopupMessageToBackgroundPage, getLatestUnexpectedError } = await loadModules()

		await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
		assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('ignore closed async response errors when broadcasting to open popups', async () => {
		const browserMock = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
		const { sendPopupMessageToOpenWindows, getLatestUnexpectedError } = await loadModules()

		await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })

		assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('ignore extension teardown errors for popup fire-and-forget messages', async () => {
		const browserMock = installBrowserMock('Extension context invalidated.')
		const { sendPopupMessageToBackgroundPage, getLatestUnexpectedError } = await loadModules()

		await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })

		assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('ignore disconnected port errors when requesting popup replies', async () => {
		const browserMock = installBrowserMock('Attempting to use a disconnected port object')
		const { sendPopupMessageWithReply, getLatestUnexpectedError } = await loadModules()

		const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMode' })

		assert.equal(reply, undefined)
		assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('treat null popup replies as no reply without recording an unexpected error', async () => {
		const browserMock = installBrowserMock('')
		// Chrome answers null when the receiving listener replies without a value.
		browserMock.handlers.runtimeMessage = () => null
		const { sendPopupMessageWithReply, getLatestUnexpectedError } = await loadModules()

		const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMode' })

		assert.equal(reply, undefined)
		assert.equal(browserMock.readStoredValue('latestUnexpectedError'), undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('parses a normal popup reply round-trip', async () => {
		const browserMock = installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies } = await loadModules()
		browserMock.handlers.runtimeMessage = () => PopupRequestsReplies.popup_requestMakeMeRichData.serialize({
			method: 'popup_requestMakeMeRichData',
			richList: [],
			makeCurrentAddressRich: true,
		})

		const reply = await sendPopupMessageWithReply({ method: 'popup_requestMakeMeRichData' })

		assert.deepEqual(reply, {
			method: 'popup_requestMakeMeRichData',
			richList: [],
			makeCurrentAddressRich: true,
		})
	})

	test('parses latest unexpected error replies with the requested reply parser', async () => {
		const browserMock = installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies } = await loadModules()
		const timestamp = new Date('2024-01-01T00:00:00.000Z')
		browserMock.handlers.runtimeMessage = () => PopupRequestsReplies.popup_requestLatestUnexpectedError.serialize({
			method: 'popup_requestLatestUnexpectedError',
			latestUnexpectedError: {
				method: 'popup_UnexpectedErrorOccured',
				data: { timestamp, message: 'boom', source: 'internal', code: 'unexpected_error', debugId: 'debug-1234' },
			},
		})

		const reply = await sendPopupMessageWithReply({ method: 'popup_requestLatestUnexpectedError' })

		assert.equal(reply?.method, 'popup_requestLatestUnexpectedError')
		assert.equal(reply?.latestUnexpectedError?.data.message, 'boom')
		assert.equal(reply?.latestUnexpectedError?.data.timestamp.valueOf(), timestamp.valueOf())
		assert.equal(reply?.latestUnexpectedError?.data.source, 'internal')
		assert.equal(reply?.latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(reply?.latestUnexpectedError?.data.debugId, 'debug-1234')
	})

	test('reports request-specific parse errors for mismatched popup replies', async () => {
		const browserMock = installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies, getLatestUnexpectedError } = await loadModules()
		browserMock.handlers.runtimeMessage = () => PopupRequestsReplies.popup_requestSimulationMode.serialize({
			method: 'popup_requestSimulationMode',
			simulationMode: true,
		})

		const reply = await withSilencedConsole(async () => await sendPopupMessageWithReply({ method: 'popup_requestLatestUnexpectedError' }))
		const latestUnexpectedError = await getLatestUnexpectedError()

		assert.equal(reply, undefined)
		assert.equal(typeof browserMock.readStoredValue('latestUnexpectedError'), 'object')
		assert.equal(latestUnexpectedError?.method, 'popup_UnexpectedErrorOccured')
		assert.ok(latestUnexpectedError?.data.message.includes('popup_requestLatestUnexpectedError'))
		assert.ok(!latestUnexpectedError?.data.message.includes('popup_requestMakeMeRichData'))
	})

	test('returns the complete visualized simulation reply instead of dropping it', async () => {
		const browserMock = installBrowserMock('unused')
		browserMock.handlers.runtimeMessage = () => undefined
		const { popupMessageHandler, PopupRequestsReplies } = await loadModules()

		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const reply = await popupMessageHandler(
			new Map(),
			simulationServicesOwner,
			{ method: 'popup_requestCompleteVisualizedSimulation' },
			homePageSettings,
			async () => undefined,
		)

		const parsedReply = PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.parse(reply)
		assert.equal(parsedReply.method, 'popup_requestCompleteVisualizedSimulation')
	})

	test('keeps popup request parsing at the dispatcher boundary', async () => {
		installBrowserMock('unused')
		const { popupMessageHandler } = await loadModules()
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const reply = ParseErrorReply.parse(await withSilencedConsole(async () => await popupMessageHandler(
			new Map(),
			simulationServicesOwner,
			{ method: 'not_a_popup_method' },
			homePageSettings,
			async () => undefined,
		)))
		assert.equal(reply.error.code, -32700)
		assert.match(reply.error.message, /not_a_popup_method/)
	})
})
