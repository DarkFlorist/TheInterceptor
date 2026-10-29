import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import Hint from '../../app/ts/components/subcomponents/Hint.js'
import { InlineCard } from '../../app/ts/components/subcomponents/InlineCard.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: Event) => boolean
	readonly focus?: () => void
	readonly blur?: () => void
	readonly getAttribute?: (name: string) => unknown
	readonly parentNode?: TestNode | null
	readonly style?: Record<string, unknown>
	readonly tagName?: string
	readonly textContent?: string
}

const warningMessage = 'Token warning details'

function findElementsByClass(node: TestNode | undefined, className: string, matches: TestNode[] = []) {
	if (node?.getAttribute?.('class') === className) matches.push(node)
	for (const child of node?.childNodes ?? []) findElementsByClass(child, className, matches)
	return matches
}

const findDisplayedHintTexts = (dom: ReturnType<typeof installDomMock>) => findElementsByClass(dom.document.body, 'preact-hint__content').map((hint) => hint.textContent)

async function renderWarningSigns(dom: ReturnType<typeof installDomMock>, isInsidePageHint: boolean) {
	const card = <InlineCard icon = { () => <span>Token</span> } label = 'TKN' warningMessage = { warningMessage } noCopy noExpandButtons />
	await act(() => { render(isInsidePageHint ? <Hint>{ card }</Hint> : card, dom.document.body) })
	const [leadingSign, trailingSign] = findElementsByClass(dom.document.body, 'inline-card-warning-sign')
	if (leadingSign?.dispatchEvent === undefined || trailingSign?.dispatchEvent === undefined) throw new Error('warning signs were not rendered')
	return { leadingSign, trailingSign }
}

// The card's spacing rules expect the signs to be its direct children, and its parent's layout expects the card's own box, so the single Hint around a warning card must be a container that adds no box.
test('wraps a warning card in one inline Hint container that adds no box and keeps the signs direct children of the card', async () => {
	const dom = installDomMock()
	try {
		const { leadingSign, trailingSign } = await renderWarningSigns(dom, false)
		const card = leadingSign.parentNode
		assert.equal(card?.getAttribute?.('class'), 'inline-card')
		assert.equal(trailingSign.parentNode, card)
		const hintContainer = card?.parentNode
		assert.equal(hintContainer?.tagName, 'SPAN')
		assert.equal(hintContainer?.style?.['cssText'], 'display: contents;')
		assert.equal(hintContainer?.parentNode, dom.document.body)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})

test('leaves a card without a warning unwrapped', async () => {
	const dom = installDomMock()
	try {
		await act(() => { render(<InlineCard icon = { () => <span>Address</span> } label = 'Alice' noCopy noExpandButtons />, dom.document.body) })
		assert.equal(findElementsByClass(dom.document.body, 'inline-card')[0]?.parentNode, dom.document.body)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})

// A warning card brings its own Hint, so the explanation must appear without a page Hint around the card, and only once inside one.
for (const isInsidePageHint of [false, true]) {
	describe(`InlineCard warning sign ${ isInsidePageHint ? 'inside' : 'without' } a page Hint container`, () => {
		test('shows the explanation once while the pointer is over either warning sign', async () => {
			const dom = installDomMock()
			try {
				const { leadingSign, trailingSign } = await renderWarningSigns(dom, isInsidePageHint)
				for (const warningSign of [leadingSign, trailingSign]) {
					await act(() => { warningSign.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
					await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
					assert.deepEqual(findDisplayedHintTexts(dom), [warningMessage])
					await act(() => { warningSign.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
					assert.deepEqual(findDisplayedHintTexts(dom), [])
				}
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		})

		test('shows the explanation once while the leading sign has keyboard focus and the pointer is over the trailing sign', async () => {
			const dom = installDomMock()
			try {
				const { leadingSign, trailingSign } = await renderWarningSigns(dom, isInsidePageHint)
				await act(() => {
					leadingSign.focus?.()
					leadingSign.dispatchEvent?.(new Event('focusin', { bubbles: true }))
				})
				await act(() => { trailingSign.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
				await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
				assert.deepEqual(findDisplayedHintTexts(dom), [warningMessage])
				// Leaving the trailing sign returns the explanation to the focused leading sign instead of hiding it.
				await act(() => { trailingSign.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
				assert.deepEqual(findDisplayedHintTexts(dom), [warningMessage])
				await act(() => {
					leadingSign.blur?.()
					leadingSign.dispatchEvent?.(new Event('focusout', { bubbles: true }))
				})
				assert.deepEqual(findDisplayedHintTexts(dom), [])
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		})

		test('shows the explanation once while the leading warning sign has keyboard focus', async () => {
			const dom = installDomMock()
			try {
				const { leadingSign } = await renderWarningSigns(dom, isInsidePageHint)
				await act(() => {
					leadingSign.focus?.()
					leadingSign.dispatchEvent?.(new Event('focusin', { bubbles: true }))
				})
				assert.deepEqual(findDisplayedHintTexts(dom), [warningMessage])
				await act(() => {
					leadingSign.blur?.()
					leadingSign.dispatchEvent?.(new Event('focusout', { bubbles: true }))
				})
				assert.deepEqual(findDisplayedHintTexts(dom), [])
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		})
	})
}
