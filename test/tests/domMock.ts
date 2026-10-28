// Minimal DOM for rendering Preact components in bun tests.
//
// Usage:
//   const dom = installDomMock()                                   // installs document, window, the element "constructors" used by instanceof checks, and inert timers
//   render(h(Component, props), dom.document.body)
//   const button = getButtonByText(dom.document.body, 'Save')        // query helpers live in test/tests/domQueries.ts
//   dom.restore()
//
// Nodes are plain objects. parentNode, firstChild, getAttribute and closest report a missing node or attribute with null because Preact's render container type and the DOM API they mirror use null. setAttribute stores values as strings, like the DOM. Preact assigns its own fields (such as the `l` record of on* handlers) directly onto the nodes. There is no nextSibling, so Preact appends nodes it would otherwise insert after a sibling.
import type { render } from 'preact'
import { replaceGlobal } from '../harness/globals.js'

// The container type that Preact's render() accepts; every mock node satisfies it structurally.
type RenderContainer = Parameters<typeof render>[1]

const ELEMENT_NODE = 1
const TEXT_NODE = 3

export type MockEventListener = (event: Event) => unknown
// Preact keeps the handlers registered through on* props on the element's minified `l` record, keyed by event name and capture flag (for example 'Clickfalse').
export type PreactEventHandlers = Record<string, (event: unknown) => unknown>

export type MockStyle = {
	cssText?: string
	setProperty: (name: string, value: string) => void
	removeProperty: (name: string) => void
	// Reads a property that Preact assigned directly (style.position = ...) or through setProperty; missing properties read as ''.
	getPropertyValue: (name: string) => string
}

export type MockRect = {
	readonly height: number
	readonly width: number
	readonly x: number
	readonly y: number
	readonly top: number
	readonly right: number
	readonly bottom: number
	readonly left: number
}

type MockNodeFields = {
	readonly ownerDocument: MockDocument
	parentNode: MockNode | null
	childNodes: MockNode[]
	readonly firstChild: MockNode | null
	textContent: string
	appendChild: (node: RenderContainer) => MockNode
	insertBefore: (node: RenderContainer, before: RenderContainer | null | undefined) => MockNode
	removeChild: (node: RenderContainer) => MockNode
	replaceChild: (node: RenderContainer, oldNode: RenderContainer) => MockNode
	contains: (node: RenderContainer | null) => boolean
}

export type MockTextNode = MockNodeFields & {
	readonly nodeType: typeof TEXT_NODE
	data: string
}

export type MockElement = MockNodeFields & {
	readonly nodeType: typeof ELEMENT_NODE
	readonly tagName: string
	readonly nodeName: string
	clientHeight: number
	onscroll: unknown
	scrollTop: number
	readonly attributes: Readonly<Record<string, string>>
	readonly eventListeners: Map<string, Set<MockEventListener>>
	readonly style: MockStyle
	setAttribute: (name: string, value: unknown) => void
	removeAttribute: (name: string) => void
	getAttribute: (name: string) => string | null
	hasAttribute: (name: string) => boolean
	addEventListener: (type: string, listener: MockEventListener) => void
	removeEventListener: (type: string, listener: MockEventListener) => void
	dispatchEvent: (event: Event) => boolean
	focus: () => undefined
	blur: () => undefined
	// Form controls keep the message from setCustomValidity; reportValidity reports whether it is empty, without showing anything.
	validationMessage: string
	setCustomValidity: (message: string) => void
	reportValidity: () => boolean
	showPopover: () => undefined
	hidePopover: () => undefined
	togglePopover: () => undefined
	getBoundingClientRect: () => MockRect
	// Supports only attribute-presence selectors such as '[data-hint]'.
	closest: (selector: string) => MockElement | null
	// Assigned by Preact, not by the mock.
	l?: PreactEventHandlers
	// Not implemented by the mock; tests that observe scrolling assign it.
	scrollIntoView?: (options?: ScrollIntoViewOptions) => void
}

type MockDialogElement = MockElement & {
	open: boolean
	returnValue: string
	showModal: () => void
	close: (returnValue?: string) => void
}

export type MockNode = MockTextNode | MockElement

export type MockDocument = {
	readonly body: MockElement
	addEventListener: () => undefined
	removeEventListener: () => undefined
	createElement: (tagName: string) => MockElement
	createElementNS: (namespace: string, tagName: string) => MockElement
	createTextNode: (data: string) => MockTextNode
}

const mockNodes = new WeakSet<object>()
const mockElements = new WeakSet<object>()

const isMockNode = (value: unknown): value is MockNode => typeof value === 'object' && value !== null && mockNodes.has(value)
export const isMockElement = (value: unknown): value is MockElement => typeof value === 'object' && value !== null && mockElements.has(value)

function requireMockNode(value: unknown) {
	if (!isMockNode(value)) throw new Error('Expected a node created by the DOM mock')
	return value
}

function appendChildTo(parent: MockNode, child: RenderContainer) {
	const node = requireMockNode(child)
	if (node.parentNode !== null) node.parentNode.removeChild(node)
	node.parentNode = parent
	parent.childNodes.push(node)
	return node
}

function insertChildBefore(parent: MockNode, child: RenderContainer, before: RenderContainer | null | undefined) {
	const node = requireMockNode(child)
	if (before === null || before === undefined) return parent.appendChild(node)
	const referenceNode = requireMockNode(before)
	if (node.parentNode !== null) node.parentNode.removeChild(node)
	node.parentNode = parent
	const index = parent.childNodes.indexOf(referenceNode)
	if (index < 0) return parent.appendChild(node)
	parent.childNodes.splice(index, 0, node)
	return node
}

function removeChildFrom(parent: MockNode, child: RenderContainer) {
	const node = requireMockNode(child)
	const index = parent.childNodes.indexOf(node)
	if (index >= 0) parent.childNodes.splice(index, 1)
	node.parentNode = null
	return node
}

function replaceChildOf(parent: MockNode, child: RenderContainer, oldChild: RenderContainer) {
	const node = requireMockNode(child)
	const oldNode = requireMockNode(oldChild)
	const index = parent.childNodes.indexOf(oldNode)
	if (index < 0) return parent.appendChild(node)
	if (node.parentNode !== null) node.parentNode.removeChild(node)
	node.parentNode = parent
	parent.childNodes[index] = node
	oldNode.parentNode = null
	return oldNode
}

function nodeContains(node: MockNode, other: RenderContainer | null): boolean {
	if (other === null) return false
	if (Object.is(node, other)) return true
	return node.childNodes.some((child) => child.contains(other))
}

function createTextNode(ownerDocument: MockDocument, initialData: string) {
	const textNode: MockTextNode = {
		nodeType: TEXT_NODE,
		ownerDocument,
		parentNode: null,
		childNodes: [],
		data: initialData,
		get firstChild() { return textNode.childNodes[0] ?? null },
		get textContent() { return textNode.data },
		set textContent(value: string) { textNode.data = value },
		appendChild: (child) => appendChildTo(textNode, child),
		insertBefore: (child, before) => insertChildBefore(textNode, child, before),
		removeChild: (child) => removeChildFrom(textNode, child),
		replaceChild: (child, oldChild) => replaceChildOf(textNode, child, oldChild),
		contains: (other) => nodeContains(textNode, other),
	}
	mockNodes.add(textNode)
	return textNode
}

function createStyle(): MockStyle {
	const style: MockStyle = {
		setProperty: (name, value) => { Reflect.set(style, name, value) },
		removeProperty: (name) => { Reflect.deleteProperty(style, name) },
		getPropertyValue: (name) => {
			const value: unknown = Reflect.get(style, name)
			return value === undefined || value === null ? '' : String(value)
		},
	}
	return style
}

// Each installDomMock() registers its elements here so that the Element, HTMLDivElement and HTMLDialogElement globals it installs only match its own nodes.
type ElementOwner = {
	readonly elements: WeakSet<object>
	readonly dialogs: WeakSet<object>
}

function createElement(ownerDocument: MockDocument, tagName: string, owner: ElementOwner | undefined): MockElement {
	const attributes: Record<string, string> = {}
	const element: MockElement = {
		nodeType: ELEMENT_NODE,
		ownerDocument,
		parentNode: null,
		childNodes: [],
		tagName: tagName.toUpperCase(),
		nodeName: tagName.toUpperCase(),
		clientHeight: 40,
		onscroll: undefined,
		scrollTop: 0,
		attributes,
		eventListeners: new Map(),
		style: createStyle(),
		get firstChild() { return element.childNodes[0] ?? null },
		get textContent() { return element.childNodes.map((node) => node.textContent).join('') },
		set textContent(value: string) {
			element.childNodes = value === '' ? [] : [createTextNode(ownerDocument, value)]
			for (const node of element.childNodes) node.parentNode = element
		},
		appendChild: (child) => appendChildTo(element, child),
		insertBefore: (child, before) => insertChildBefore(element, child, before),
		removeChild: (child) => removeChildFrom(element, child),
		replaceChild: (child, oldChild) => replaceChildOf(element, child, oldChild),
		contains: (other) => nodeContains(element, other),
		setAttribute: (name, value) => { attributes[name] = String(value) },
		removeAttribute: (name) => { delete attributes[name] },
		getAttribute: (name) => attributes[name] ?? null,
		hasAttribute: (name) => attributes[name] !== undefined,
		addEventListener: (type, listener) => {
			const listeners = element.eventListeners.get(type) ?? new Set()
			listeners.add(listener)
			element.eventListeners.set(type, listeners)
		},
		removeEventListener: (type, listener) => { element.eventListeners.get(type)?.delete(listener) },
		dispatchEvent: (event) => {
			if (event.target === null) Object.defineProperty(event, 'target', { configurable: true, value: element })
			Object.defineProperty(event, 'currentTarget', { configurable: true, value: element })
			// Preact's event proxy reads its handlers from `this`, so listeners are called with the element as this.
			for (const listener of element.eventListeners.get(event.type) ?? []) listener.call(element, event)
			if (event.bubbles && !event.cancelBubble && isMockElement(element.parentNode)) element.parentNode.dispatchEvent(event)
			return !event.defaultPrevented
		},
		focus: () => undefined,
		blur: () => undefined,
		validationMessage: '',
		setCustomValidity: (message) => { element.validationMessage = message },
		reportValidity: () => element.validationMessage === '',
		showPopover: () => undefined,
		hidePopover: () => undefined,
		togglePopover: () => undefined,
		getBoundingClientRect: () => ({ height: element.clientHeight, width: 100, x: 0, y: 0, top: 0, right: 100, bottom: element.clientHeight, left: 0 }),
		closest: (selector) => {
			const attributeName = selector.match(/^\[([^\]]+)\]$/u)?.[1]
			if (attributeName === undefined) return null
			let candidate: MockElement | undefined = element
			while (candidate !== undefined) {
				if (candidate.hasAttribute(attributeName)) return candidate
				candidate = isMockElement(candidate.parentNode) ? candidate.parentNode : undefined
			}
			return null
		},
	}
	mockNodes.add(element)
	mockElements.add(element)
	owner?.elements.add(element)
	return element
}

function createDialogElement(ownerDocument: MockDocument, tagName: string, owner: ElementOwner | undefined): MockDialogElement {
	const dialog: MockDialogElement = Object.assign(createElement(ownerDocument, tagName, owner), {
		open: false,
		returnValue: '',
		showModal: () => { dialog.open = true },
		close: (returnValue = '') => {
			dialog.open = false
			dialog.returnValue = returnValue
			dialog.dispatchEvent(new Event('close'))
		},
	})
	owner?.dialogs.add(dialog)
	return dialog
}

function createDocument(owner: ElementOwner | undefined): MockDocument {
	const createDocumentElement = (tagName: string) => tagName.toLowerCase() === 'dialog'
		? createDialogElement(document, tagName, owner)
		: createElement(document, tagName, owner)
	const document: MockDocument = {
		get body() { return body },
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		createElement: createDocumentElement,
		createElementNS: (_namespace, tagName) => createDocumentElement(tagName),
		createTextNode: (data) => createTextNode(document, data),
	}
	const body = createElement(document, 'body', owner)
	return document
}

type MockWindow = {
	readonly document: MockDocument
	addEventListener: () => undefined
	removeEventListener: () => undefined
}

const createWindow = (document: MockDocument): MockWindow => ({ document, addEventListener: () => undefined, removeEventListener: () => undefined })

// Stands in for an element constructor in `value instanceof Element` checks.
const createInstanceofTarget = (instances: WeakSet<object>) => ({
	[Symbol.hasInstance]: (value: unknown) => typeof value === 'object' && value !== null && instances.has(value),
})

type DomMockState = {
	restored: boolean
	readonly previousValues: ReadonlyMap<string, unknown>
}

// Globals installed by installDomMock, with the value restore() falls back to when nothing was installed before. A restored mock leaves an inert document and window behind so Preact work that is still queued after a test does not crash on a missing global.
const fallbackDocument = createDocument(undefined)
const fallbackRequestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(performance.now()), 0))
const fallbackCancelAnimationFrame = (handle: number) => { clearTimeout(handle) }
const domGlobalFallbacks: ReadonlyMap<string, unknown> = new Map<string, unknown>([
	['document', fallbackDocument],
	['window', createWindow(fallbackDocument)],
	['setInterval', undefined],
	['clearInterval', undefined],
	['requestAnimationFrame', fallbackRequestAnimationFrame],
	['cancelAnimationFrame', fallbackCancelAnimationFrame],
	['HTMLDialogElement', undefined],
	['HTMLDivElement', undefined],
	['Element', undefined],
])
const domMockOwners = new Map<unknown, DomMockState>()

const defineGlobalValue = (name: string, value: unknown) => {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

// When the value a mock replaced belongs to another mock that was already restored, follow that mock's own previous value instead.
function resolveRestorablePreviousValue(name: string, previousValue: unknown): unknown {
	const owner = domMockOwners.get(previousValue)
	if (owner?.restored === true) return resolveRestorablePreviousValue(name, owner.previousValues.get(name))
	return previousValue ?? domGlobalFallbacks.get(name)
}

export function installDomMock() {
	const owner: ElementOwner = { elements: new WeakSet(), dialogs: new WeakSet() }
	const document = createDocument(owner)
	const window = createWindow(document)
	const elementTarget = createInstanceofTarget(owner.elements)
	const installedValues = new Map<string, unknown>([
		['document', document],
		['window', window],
		['setInterval', () => 1],
		['clearInterval', () => undefined],
		['requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0)
			return 1
		}],
		['cancelAnimationFrame', () => undefined],
		['HTMLDialogElement', createInstanceofTarget(owner.dialogs)],
		['HTMLDivElement', elementTarget],
		['Element', elementTarget],
	])
	const state: DomMockState = {
		restored: false,
		previousValues: new Map([...installedValues.keys()].map((name): [string, unknown] => [name, Reflect.get(globalThis, name)])),
	}
	for (const [name, value] of installedValues) {
		domMockOwners.set(value, state)
		defineGlobalValue(name, value)
	}

	return {
		document,
		restore() {
			// Tests in one file can overlap (a later test may install its own DOM mock before an earlier render finishes), so only restore globals this mock still owns, and never leave Preact cleanup with an undefined global document.
			state.restored = true
			for (const [name, value] of installedValues) {
				const current: unknown = Reflect.get(globalThis, name)
				const isOwnedByThisMock = Object.is(current, value) || (name === 'window' && Object.is(globalThis.window?.document, document))
				if (isOwnedByThisMock) defineGlobalValue(name, resolveRestorablePreviousValue(name, state.previousValues.get(name)))
			}
		},
	}
}

// Replaces Date so that `new Date()`, `new Date(undefined)` and Date.now() read a clock the test controls; other Date calls behave normally.
export function installDateMock(initialNow: Date | string | number) {
	const RealDate = Date
	let currentNow = new RealDate(initialNow).getTime()
	const MockDate = new Proxy(RealDate, {
		construct: (target, argumentList, newTarget) => Reflect.construct(target, argumentList[0] === undefined ? [currentNow] : argumentList, newTarget),
		get: (target, property, receiver) => property === 'now' ? () => currentNow : Reflect.get(target, property, receiver),
	})
	const restoreDate = replaceGlobal('Date', MockDate)

	return {
		setNow(nextNow: Date | string | number) {
			currentNow = new RealDate(nextNow).getTime()
		},
		restore: restoreDate,
	}
}
