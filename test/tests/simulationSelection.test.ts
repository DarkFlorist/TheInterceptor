import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { selectionChanged, selectionNeedsRefresh, type SimulationSelection } from '../../app/ts/utils/simulationSelection.js'

const firstEndpoint: RpcNetwork = { name: 'Test Chain', chainId: 1n, httpsRpc: 'https://first-endpoint.example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
// Same chain on another endpoint, so changing endpoints leaves the stack context alone.
const otherEndpoint: RpcNetwork = { ...firstEndpoint, name: 'Test Chain (other endpoint)', httpsRpc: 'https://other-endpoint.example.invalid' }
const safeA = 0x1111111111111111111111111111111111111111n
const safeB = 0x2222222222222222222222222222222222222222n

type StackChoice = Pick<SimulationSelection, 'simulationMode' | 'activeSigningSafeAddress'>
const stackChoices: readonly StackChoice[] = [true, false].flatMap((simulationMode) => [undefined, safeA, safeB].map((activeSigningSafeAddress) => ({ simulationMode, activeSigningSafeAddress })))

const describeChoice = (choice: StackChoice) => `${ choice.simulationMode ? 'simulation' : 'signing' } with ${ choice.activeSigningSafeAddress === undefined ? 'no Safe' : choice.activeSigningSafeAddress === safeA ? 'Safe A' : 'Safe B' }`

// The documented rule, written out without the code under test: simulation mode always shows the one simulation stack, whichever Safe is set; signing shows the stack of its Safe, or none without one; a different endpoint is always a different selection.
const expectedStack = (choice: StackChoice) => choice.simulationMode ? 'simulation stack' : choice.activeSigningSafeAddress === undefined ? 'no stack' : `stack of Safe ${ choice.activeSigningSafeAddress === safeA ? 'A' : 'B' }`
const expectedChanged = (from: StackChoice, to: StackChoice, endpointChanged: boolean) => endpointChanged || expectedStack(from) !== expectedStack(to)
const expectedQueuesRefresh = (from: StackChoice, to: StackChoice, endpointChanged: boolean) => expectedChanged(from, to, endpointChanged) && expectedStack(to) !== 'no stack'

const transitions = stackChoices.flatMap((from) => stackChoices.flatMap((to) => [false, true].map((endpointChanged) => ({ from, to, endpointChanged }))))

// The enqueue side is activeSettings.ts, which queues a refresh when selectionNeedsRefresh holds; the abort side is popupVisualisationUpdater.ts, where a refresh made for `from` steps aside when selectionChanged holds against the current selection.
for (const { from, to, endpointChanged } of transitions) test(`a selection change and a refresh left behind by it agree: ${ describeChoice(from) } to ${ describeChoice(to) }${ endpointChanged ? ' on another endpoint' : '' }`, () => {
	const fromSelection: SimulationSelection = { ...from, activeRpcNetwork: endpointChanged ? otherEndpoint : firstEndpoint }
	const toSelection: SimulationSelection = { ...to, activeRpcNetwork: firstEndpoint }
	const refreshStepsAside = selectionChanged(fromSelection, toSelection)
	const changeQueuesRefresh = selectionNeedsRefresh(fromSelection, toSelection)
	assert.equal(refreshStepsAside, expectedChanged(from, to, endpointChanged))
	assert.equal(changeQueuesRefresh, expectedQueuesRefresh(from, to, endpointChanged))
	// A refresh only steps aside for a change, and every change that steps a refresh aside queues its replacement unless the new selection shows no stack: external-wallet signing without a Safe.
	if (changeQueuesRefresh) assert.equal(refreshStepsAside, true, 'A change queued a refresh while the refresh for the previous selection still publishes over it')
	if (refreshStepsAside && !changeQueuesRefresh) assert.equal(expectedStack(to), 'no stack', 'A refresh stepped aside with no refresh queued for a selection that shows a stack')
})

test('switching to external-wallet signing without a Safe steps a refresh aside and queues none, so nothing publishes the previous stack', () => {
	for (const from of stackChoices.filter((choice) => expectedStack(choice) !== 'no stack')) {
		for (const activeRpcNetwork of [firstEndpoint, otherEndpoint]) {
			const to: SimulationSelection = { simulationMode: false, activeSigningSafeAddress: undefined, activeRpcNetwork }
			assert.equal(selectionChanged({ ...from, activeRpcNetwork: firstEndpoint }, to), true)
			assert.equal(selectionNeedsRefresh({ ...from, activeRpcNetwork: firstEndpoint }, to), false)
		}
	}
})

test('changing the Safe while staying in simulation mode keeps the selection on both sides', () => {
	const safeChanges: readonly (readonly [bigint | undefined, bigint | undefined])[] = [[undefined, safeA], [safeA, safeB], [safeB, undefined]]
	for (const [fromSafe, toSafe] of safeChanges) {
		const from: SimulationSelection = { simulationMode: true, activeSigningSafeAddress: fromSafe, activeRpcNetwork: firstEndpoint }
		const to: SimulationSelection = { ...from, activeSigningSafeAddress: toSafe }
		assert.equal(selectionChanged(from, to), false)
		assert.equal(selectionNeedsRefresh(from, to), false)
	}
})

test('switching from external-wallet signing to Safe signing steps a refresh aside and queues one for the Safe stack', () => {
	const from: SimulationSelection = { simulationMode: false, activeSigningSafeAddress: undefined, activeRpcNetwork: firstEndpoint }
	const to: SimulationSelection = { ...from, activeSigningSafeAddress: safeA }
	assert.equal(selectionChanged(from, to), true)
	assert.equal(selectionNeedsRefresh(from, to), true)
})

test('editing the metadata of the selected endpoint keeps the selection on both sides', () => {
	const from: SimulationSelection = { simulationMode: true, activeSigningSafeAddress: undefined, activeRpcNetwork: firstEndpoint }
	const to: SimulationSelection = { ...from, activeRpcNetwork: { ...firstEndpoint, name: 'Renamed Test Chain', currencyName: 'Test Ether' } }
	assert.equal(selectionChanged(from, to), false)
	assert.equal(selectionNeedsRefresh(from, to), false)
})
