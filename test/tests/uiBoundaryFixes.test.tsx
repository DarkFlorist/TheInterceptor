import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { findChainEntryByName } from '../../app/ts/components/subcomponents/ChainSelector.js'
import { DropDownMenu } from '../../app/ts/components/subcomponents/DropDownMenu.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { parseTimePickerDeltaValue, TimePicker } from '../../app/ts/components/subcomponents/TimePicker.js'
import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../../app/ts/components/ui-utils.js'
import { parseRpcFormData } from '../../app/ts/utils/rpcFormData.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function createRpcFormData(apiKey: string) {
	const formData = new FormData()
	formData.set('name', 'Test RPC')
	formData.set('chainId', '1')
	formData.set('httpsRpc', 'https://rpc.example')
	formData.set('currencyName', 'Ether')
	formData.set('currencyTicker', 'ETH')
	formData.set('blockExplorerUrl', 'https://explorer.example/api')
	formData.set('blockExplorerApiKey', apiKey)
	return formData
}

describe('UI boundary fixes', () => {
	test('selects normalized and synthetic chain entries by their displayed names', () => {
		const chains = rpcEntriesToChainEntriesWithAllChainsEntry([{
			name: 'Custom Ethereum Name',
			chainId: 1n,
			httpsRpc: 'https://rpc.example',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: false,
			minimized: true,
		}])

		assert.equal(findChainEntryByName(chains, 'Ethereum Mainnet')?.chainId, 1n)
		assert.equal(findChainEntryByName(chains, 'All Chains')?.chainId, 'AllChains')
	})

	test('keeps dropdown controls from submitting surrounding forms', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<form><DropDownMenu selected = { signal('One') } dropDownOptions = { signal<readonly string[]>(['One', 'Two']) } onChangedCallBack = { () => undefined } buttonClassses = 'button-class' /></form>, dom.document.body)
			})

			const buttons = collectElements(dom.document.body, 'button')
			assert.equal(buttons.length, 3)
			assert.equal(buttons.every((button) => button.getAttribute?.('type') === 'button'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('renders warning details supplied by InlineCard callers', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<InlineCard icon = { () => <span>Token</span> } label = 'TKN' warningMessage = 'Untrusted address' noCopy noExpandButtons />, dom.document.body)
			})

			const warningSigns = collectElements(dom.document.body, 'span').filter((element) => element.getAttribute?.('role') === 'alert')
			assert.equal(warningSigns.length, 2)
			assert.equal(warningSigns.every((warningSign) => warningSign.getAttribute?.('title') === 'Untrusted address'), true)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('parses and renders bigint delays without Number precision loss', async () => {
		const largeDelay = 9_007_199_254_740_993n
		assert.equal(parseTimePickerDeltaValue(largeDelay.toString()), largeDelay)
		assert.equal(parseTimePickerDeltaValue('1.5'), undefined)

		const dom = installDomMock()
		try {
			await act(() => {
				render(<TimePicker mode = { signal('For') } absoluteTime = { signal(undefined) } deltaValue = { signal(largeDelay) } deltaUnit = { signal('Seconds') } onChangedCallBack = { () => undefined } startText = 'Delay' removeNoDelayOption = { false } />, dom.document.body)
			})

			const numberInput = collectElements(dom.document.body, 'input').find((input) => input.getAttribute?.('type') === 'number')
			assert.equal(numberInput?.getAttribute?.('value'), largeDelay.toString())
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps a block explorer URL when its API key is empty', () => {
		const parsed = parseRpcFormData(createRpcFormData(''))

		assert.equal(parsed.success, true)
		if (!parsed.success) throw new Error(parsed.message)
		assert.deepEqual(parsed.value.blockExplorer, { apiUrl: 'https://explorer.example/api', apiKey: '' })
	})
})
