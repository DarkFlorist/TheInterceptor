import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { DropDownMenu } from '../../app/ts/components/subcomponents/DropDownMenu.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { hasValidTimePickerValue, parseTimePickerDeltaValue, TimePicker } from '../../app/ts/components/subcomponents/TimePicker.js'
import { synchronizeViewConfig, ViewSelector } from '../../app/ts/components/subcomponents/ViewSelector.js'
import { installDomMock } from './domMock.js'
import { collectElements } from './domQueries.js'

describe('popup controls: dropdowns, view selector, inline card warnings and time picker', () => {
	test('keeps dropdown controls from submitting surrounding forms', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<form><DropDownMenu selected = { signal('One') } dropDownOptions = { signal<readonly string[]>(['One', 'Two']) } onChangedCallBack = { () => undefined } buttonClassses = 'button-class' /></form>, dom.document.body)
			})

			const buttons = collectElements(dom.document.body, 'button')
			assert.equal(buttons.length, 3)
			assert.equal(buttons.every((button) => button.getAttribute('type') === 'button'), true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('combines a dropdown field label with its selected value', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<DropDownMenu selected = { signal('safe') } dropDownOptions = { signal<readonly string[]>(['safe']) } onChangedCallBack = { () => undefined } buttonClassses = 'button-class' ariaLabel = 'Address type' />, dom.document.body)
			})

			const trigger = collectElements(dom.document.body, 'button').find((button) => button.getAttribute('aria-haspopup') === 'true')
			assert.equal(trigger?.getAttribute('aria-label'), 'Address type: safe')
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('gives each dropdown its own menu id and matching accessibility target', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<div>
					<DropDownMenu selected = { signal('One') } dropDownOptions = { signal<readonly string[]>(['One']) } onChangedCallBack = { () => undefined } buttonClassses = 'first-dropdown' />
					<DropDownMenu selected = { signal('Two') } dropDownOptions = { signal<readonly string[]>(['Two']) } onChangedCallBack = { () => undefined } buttonClassses = 'second-dropdown' />
				</div>, dom.document.body)
			})

			const menuIds = collectElements(dom.document.body, 'div')
				.filter((element) => element.getAttribute('role') === 'menu')
				.map((element) => element.getAttribute('id'))
			const controlledIds = collectElements(dom.document.body, 'button')
				.filter((element) => element.getAttribute('aria-haspopup') === 'true')
				.map((element) => element.getAttribute('aria-controls'))
			assert.equal(menuIds.length, 2)
			assert.equal(new Set(menuIds).size, 2)
			assert.deepEqual(controlledIds, menuIds)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('updates view content when active-view props change', async () => {
		const dom = installDomMock()
		const selector = (showParsed: boolean) => <ViewSelector id = 'dynamic-view'>
			<ViewSelector.List>
				<ViewSelector.View title = 'Parsed' value = 'parsed' isActive = { showParsed }>Parsed content</ViewSelector.View>
				<ViewSelector.View title = 'Raw' value = 'raw' isActive = { !showParsed }>Raw content</ViewSelector.View>
			</ViewSelector.List>
			<ViewSelector.Triggers />
		</ViewSelector>
		try {
			await act(() => render(selector(false), dom.document.body))
			assert.equal(dom.document.body.textContent.includes('Raw content'), true)
			assert.equal(dom.document.body.textContent.includes('Parsed content'), false)

			await act(() => render(selector(true), dom.document.body))
			assert.equal(dom.document.body.textContent.includes('Parsed content'), true)
			assert.equal(dom.document.body.textContent.includes('Raw content'), false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('preserves manual view selection across title-only updates', () => {
		let views = synchronizeViewConfig([], { title: 'Parsed', value: 'parsed', isActive: true }, 'activate')
		views = synchronizeViewConfig(views, { title: 'Raw', value: 'raw', isActive: false }, 'preserve')
		views = views.map(view => ({ ...view, isActive: view.value === 'raw' }))
		views = synchronizeViewConfig(views, { title: 'Decoded', value: 'parsed', isActive: true }, 'preserve')

		assert.equal(views.find(view => view.value === 'raw')?.isActive, true)
		assert.equal(views.find(view => view.value === 'parsed')?.isActive, false)
		assert.equal(views.find(view => view.value === 'parsed')?.title, 'Decoded')
	})

	test('renders warning details supplied by InlineCard callers', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<InlineCard icon = { () => <span>Token</span> } label = 'TKN' warningMessage = 'Untrusted address' noCopy noExpandButtons />, dom.document.body)
			})

			const warningSigns = collectElements(dom.document.body, 'span').filter((element) => element.getAttribute('role') === 'alert')
			assert.equal(warningSigns.length, 2)
			assert.equal(warningSigns.every((warningSign) => warningSign.getAttribute('title') === 'Untrusted address'), true)
		} finally {
			render(undefined, dom.document.body)
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

			const numberInput = collectElements(dom.document.body, 'input').find((input) => input.getAttribute('type') === 'number')
			assert.equal(numberInput?.getAttribute('value'), largeDelay.toString())
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('requires a value before committing Until or For time picker modes', () => {
		assert.equal(hasValidTimePickerValue('Until', undefined, 1n), false)
		assert.equal(hasValidTimePickerValue('Until', new Date('2024-01-01T00:00:00.000Z'), undefined), true)
		assert.equal(hasValidTimePickerValue('For', undefined, undefined), false)
		assert.equal(hasValidTimePickerValue('For', undefined, 0n), true)
		assert.equal(hasValidTimePickerValue('No Delay', undefined, undefined), true)
	})
})
