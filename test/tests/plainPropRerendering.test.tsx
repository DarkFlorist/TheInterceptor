// Components that derive their output from plain props must follow new props on a re-render. A cached useComputed only recomputes when a signal it read changes, so output computed in one from a plain prop would keep showing the first render's value.
import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { TransactionNames } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { SettingsView } from '../../app/ts/components/pages/SettingsView.js'
import { ConfigureRpcConnection } from '../../app/ts/components/subcomponents/ConfigureRpcConnection.js'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { installDomMock } from './domMock.js'
import { collectElements, getElement, getNormalizedText } from './domQueries.js'
import { createRuntimeMessagingInstaller, type RuntimeMessaging } from './runtimeMessagingTestHarness.js'

const installRuntimeMessaging = createRuntimeMessagingInstaller()

const firstRpc: RpcEntry = {
	name: 'First RPC',
	chainId: 1n,
	httpsRpc: 'https://first.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
	blockExplorer: { apiUrl: 'https://first.example/api', apiKey: 'first-key' },
}

const secondRpc: RpcEntry = {
	name: 'Second RPC',
	chainId: 100n,
	httpsRpc: 'https://second.example',
	currencyName: 'xDai',
	currencyTicker: 'XDAI',
	primary: true,
	minimized: true,
	blockExplorer: { apiUrl: 'https://second.example/api', apiKey: 'second-key' },
}

describe('ConfigureRpcConnection form defaults', () => {
	test('follow a changed RPC entry while the form stays mounted', async () => {
		installRuntimeMessaging()
		const dom = installDomMock()
		const readDefaultValues = () => Object.fromEntries(collectElements(dom.document.body, 'input').map((input) => [input.getAttribute('name'), input.getAttribute('defaultValue')]))
		try {
			await act(() => { render(h(ConfigureRpcConnection, { rpcInfo: firstRpc }), dom.document.body) })
			assert.deepEqual(readDefaultValues(), {
				httpsRpc: 'https://first.example',
				name: 'First RPC',
				chainId: '1',
				currencyName: 'Ether',
				currencyTicker: 'ETH',
				blockExplorerUrl: 'https://first.example/api',
				blockExplorerApiKey: 'first-key',
			})

			await act(() => { render(h(ConfigureRpcConnection, { rpcInfo: secondRpc }), dom.document.body) })
			assert.deepEqual(readDefaultValues(), {
				httpsRpc: 'https://second.example',
				name: 'Second RPC',
				chainId: '100',
				currencyName: 'xDai',
				currencyTicker: 'XDAI',
				blockExplorerUrl: 'https://second.example/api',
				blockExplorerApiKey: 'second-key',
			})
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})
})

describe('SettingsView checkboxes', () => {
	const settingsReply = (useTabsInsteadOfPopup: boolean, metamaskCompatibilityMode: boolean, safeAppsCompatibilityMode: boolean) => MessageToPopup.serialize({
		role: 'all',
		method: 'popup_requestSettingsReply',
		data: { useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode, activeRpcNetwork: firstRpc, rpcEntries: [firstRpc] },
	})

	const deliverSettingsReply = async (messaging: RuntimeMessaging, reply: unknown) => await act(async () => { await messaging.dispatchAndAwaitListeners(reply) })

	test('follow every settings reply', async () => {
		const messaging = installRuntimeMessaging()
		const dom = installDomMock()
		const readCheckedStates = () => collectElements(dom.document.body, 'input')
			.filter((input) => input.getAttribute('type') === 'checkbox')
			.map((input) => input.hasAttribute('checked'))
		try {
			await act(() => { render(h(SettingsView, {}), dom.document.body) })
			assert.deepEqual(readCheckedStates(), [false, false, false])

			await deliverSettingsReply(messaging, settingsReply(true, false, true))
			assert.deepEqual(readCheckedStates(), [true, false, true])

			await deliverSettingsReply(messaging, settingsReply(false, true, false))
			assert.deepEqual(readCheckedStates(), [false, true, false])
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})
})

describe('TransactionNames', () => {
	const completedSimulation: CompleteVisualizedSimulation = {
		...createPassthroughCompleteVisualizedSimulation(1, 'done', 2),
		simulationState: toResolvedSimulationState({
			success: true,
			simulationStateInput: [],
			simulatedBlocks: [],
			blockNumber: 1n,
			blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			baseFeePerGas: 1n,
			simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
			rpcNetwork: firstRpc,
		}),
	}

	test('adds or drops the current transaction when includeCurrentTransaction changes', async () => {
		const dom = installDomMock()
		const completeVisualizedSimulation = new Signal(completedSimulation)
		// Without a pending transaction, the current transaction's breadcrumb reads 'Loading...'.
		const currentPendingTransaction = new Signal<PendingTransactionOrSignableMessage | undefined>(undefined)
		const readNames = () => collectElements(getElement(dom.document.body, (element) => element.tagName === 'NAV', 'the transaction breadcrumb'), 'p').map(getNormalizedText)
		const renderNames = async (includeCurrentTransaction: boolean) => await act(() => {
			render(h(TransactionNames, { completeVisualizedSimulation, currentPendingTransaction, includeCurrentTransaction }), dom.document.body)
		})
		try {
			await renderNames(true)
			assert.deepEqual(readNames(), ['Simply making 2 addresses rich', 'Loading...'])

			await renderNames(false)
			assert.deepEqual(readNames(), ['Simply making 2 addresses rich'])

			await renderNames(true)
			assert.deepEqual(readNames(), ['Simply making 2 addresses rich', 'Loading...'])
		} finally {
			await act(() => { render(undefined, dom.document.body) })
			dom.restore()
		}
	})
})
