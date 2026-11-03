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

// Selectors such as .safe-signer-option-address > .inline-card expect the card to be the outermost element InlineCard renders, so a warning must not add a wrapper around it; the card's spacing rules also expect the signs to be its direct children.
for (const warning of [warningMessage, undefined]) {
	test(`renders the card as its outermost element ${ warning === undefined ? 'without a warning' : 'with a warning, also while it is explained' }`, async () => {
		const dom = installDomMock()
		try {
			await act(() => { render(<InlineCard icon = { () => <span>Token</span> } label = 'TKN' warningMessage = { warning } noCopy noExpandButtons />, dom.document.body) })
			const [card, ...otherCards] = findElementsByClass(dom.document.body, 'inline-card')
			assert.equal(otherCards.length, 0)
			assert.equal(card?.parentNode, dom.document.body)
			assert.equal(dom.document.body.childNodes.length, 1)
			const warningSigns = findElementsByClass(dom.document.body, 'inline-card-warning-sign')
			assert.equal(warningSigns.length, warning === undefined ? 0 : 2)
			assert.equal(warningSigns.every((warningSign) => warningSign.parentNode === card), true)
			const [leadingSign] = warningSigns
			if (leadingSign === undefined) return
			await act(() => {
				leadingSign.focus?.()
				leadingSign.dispatchEvent?.(new Event('focusin', { bubbles: true }))
			})
			// The shown explanation is hosted inside the card, so it does not change where the card sits either.
			const [shownHint] = findElementsByClass(dom.document.body, 'preact-hint')
			assert.equal(shownHint?.parentNode, card)
			// Its empty title keeps the card's label title from appearing as a native tooltip over the explanation.
			assert.equal(shownHint?.getAttribute?.('title'), '')
			assert.equal(card?.parentNode, dom.document.body)
			assert.equal(dom.document.body.childNodes.length, 1)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
}

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
