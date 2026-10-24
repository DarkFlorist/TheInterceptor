// Query and interaction helpers for Preact trees rendered into the DOM mock from test/tests/domMock.ts.
//
// Usage:
//   const dom = installDomMock()
//   render(h(Component, props), dom.document.body)
//   const saveButton = getButtonByText(dom.document.body, 'Save')
//   await act(async () => { await clickElement(saveButton) })
//   assert.equal(isDisabled(saveButton), true)
import { act } from 'preact/test-utils'
import { flushMicrotasks, waitFor, type WaitOptions } from '../harness/async.js'
import { isMockElement, type MockElement, type MockNode } from './domMock.js'

const normalizeWhitespace = (text: string) => text.replace(/\s+/gu, ' ').trim()

export const getNormalizedText = (node: MockNode) => normalizeWhitespace(node.textContent)

// Returns root and its descendant elements that match, in document order.
function findAllElements(root: MockNode, matches: (element: MockElement) => boolean): MockElement[] {
	const matchingRoot = isMockElement(root) && matches(root) ? [root] : []
	return [...matchingRoot, ...root.childNodes.flatMap((child) => findAllElements(child, matches))]
}

// Returns root or its first descendant element that matches, in document order, or undefined when none does.
export function findElement(root: MockNode, matches: (element: MockElement) => boolean): MockElement | undefined {
	if (isMockElement(root) && matches(root)) return root
	for (const child of root.childNodes) {
		const found = findElement(child, matches)
		if (found !== undefined) return found
	}
	return undefined
}

export function getElement(root: MockNode, matches: (element: MockElement) => boolean, description: string) {
	const element = findElement(root, matches)
	if (element === undefined) throw new Error(`Expected ${ description }`)
	return element
}

export const collectElements = (root: MockNode, tagName: string) => findAllElements(root, (element) => element.tagName === tagName.toUpperCase())

const getClassNames = (element: MockElement) => (element.getAttribute('class') ?? '').split(/\s+/u).filter((className) => className !== '')

export const hasClass = (element: MockElement, className: string) => getClassNames(element).includes(className)

export const getButtonByText = (root: MockNode, text: string) => getElement(root, (element) => element.tagName === 'BUTTON' && getNormalizedText(element) === text, `button with text "${ text }"`)

export const getButtonByAriaLabel = (root: MockNode, ariaLabel: string) => getElement(root, (element) => element.tagName === 'BUTTON' && element.getAttribute('aria-label') === ariaLabel, `button with aria-label "${ ariaLabel }"`)

export const getHeaderContainingText = (root: MockNode, text: string) => getElement(root, (element) => element.tagName === 'HEADER' && element.textContent.includes(text), `header containing text "${ text }"`)

export const isDisabled = (element: MockElement) => element.hasAttribute('disabled')

// Returns the nearest ancestor element (excluding element itself) that matches.
export function findAncestor(element: MockElement, matches: (ancestor: MockElement) => boolean) {
	for (let ancestor = element.parentNode; isMockElement(ancestor); ancestor = ancestor.parentNode) {
		if (matches(ancestor)) return ancestor
	}
	return undefined
}

// Returns the handler Preact registered for an on* prop, for example getPreactEventHandler(button, 'Click') for onClick.
export function getPreactEventHandler(element: MockElement, eventName: string) {
	const handler = Object.entries(element.l ?? {}).find(([key]) => key.startsWith(eventName))?.[1]
	if (handler === undefined) throw new Error(`Expected a ${ eventName } handler on <${ element.tagName.toLowerCase() }>`)
	return handler
}

// The DOM mock does not synthesize events, so this calls the element's onClick handler directly with a minimal event; eventFields adds or overrides event properties.
export async function clickElement(element: MockElement, eventFields: Readonly<Record<string, unknown>> = {}) {
	await getPreactEventHandler(element, 'Click')({ currentTarget: element, stopPropagation: () => undefined, ...eventFields })
}

// Like clickElement, this calls the element's onKeyDown handler directly with the given event.
export async function keyDownElement(element: MockElement, event: unknown) {
	await getPreactEventHandler(element, 'KeyDown')(event)
}

// Polls condition until it holds, letting Preact apply queued renders (inside act) before each check; use it for UI that updates after async work such as lazily loaded page modules. act() only applies renders when its callback finishes, so a condition polled inside a single act() call never sees them.
export async function waitForRender(condition: () => boolean, options: WaitOptions = {}) {
	await waitFor(async () => {
		await act(async () => { await flushMicrotasks() })
		return condition()
	}, options)
}
