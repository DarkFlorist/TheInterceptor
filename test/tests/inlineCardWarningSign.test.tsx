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

// The card is a grid whose spacing rules see each sign's Hint container as the card's child, so that container must be a span without the page container's layout styles.
test('wraps each InlineCard warning sign in an unstyled inline Hint container directly inside the card', async () => {
	const dom = installDomMock()
	try {
		const warningSigns = Object.values(await renderWarningSigns(dom, false))
		for (const warningSign of warningSigns) {
			const hintContainer = warningSign.parentNode
			assert.equal(hintContainer?.tagName, 'SPAN')
			assert.equal(hintContainer?.style?.['cssText'], undefined)
			assert.equal(hintContainer?.parentNode?.getAttribute?.('class'), 'inline-card')
		}
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})

// The warning signs bring their own Hint, so the explanation must appear without a page Hint around the card, and only once inside one.
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
