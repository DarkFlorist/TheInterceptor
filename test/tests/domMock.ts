import type { render } from 'preact'

type AttributeMap = Record<string, string | undefined>
type RenderContainer = Parameters<typeof render>[1]
type TestEvent = {
	bubbles?: boolean
	cancelBubble?: boolean
	currentTarget?: TestElement
	defaultPrevented?: boolean
	preventDefault?: () => void
	shiftKey?: boolean
	stopPropagation?: () => void
	target?: TestElement
	type: string
}

class TestNode {
	readonly nodeType: number = 0
	parentNode: TestNode | null = null
	childNodes: TestNode[] = []
	ownerDocument: TestDocument

	constructor(ownerDocument: TestDocument) {
		this.ownerDocument = ownerDocument
	}

	appendChild(node: RenderContainer) {
		if (!(node instanceof TestNode)) throw new Error('Expected TestNode')
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes.push(node)
		return node
	}

	insertBefore(node: RenderContainer, before: RenderContainer | null) {
		if (!(node instanceof TestNode)) throw new Error('Expected TestNode')
		if (before === null || before === undefined) return this.appendChild(node)
		if (!(before instanceof TestNode)) throw new Error('Expected TestNode')
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		const index = this.childNodes.indexOf(before)
		if (index < 0) return this.appendChild(node)
		this.childNodes.splice(index, 0, node)
		return node
	}

	removeChild(node: RenderContainer) {
		if (!(node instanceof TestNode)) throw new Error('Expected TestNode')
		const index = this.childNodes.indexOf(node)
		if (index >= 0) this.childNodes.splice(index, 1)
		node.parentNode = null
		return node
	}

	replaceChild(node: RenderContainer, oldNode: RenderContainer) {
		if (!(node instanceof TestNode)) throw new Error('Expected TestNode')
		if (!(oldNode instanceof TestNode)) throw new Error('Expected TestNode')
		const index = this.childNodes.indexOf(oldNode)
		if (index < 0) return this.appendChild(node)
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes[index] = node
		oldNode.parentNode = null
		return oldNode
	}

	get firstChild(): TestNode | null {
		return this.childNodes[0] ?? null
	}

	get textContent(): string {
		return this.childNodes.map((node) => node.textContent).join('')
	}

	set textContent(value: string) {
		this.childNodes = value === '' ? [] : [new TestTextNode(this.ownerDocument, value)]
		for (const node of this.childNodes) node.parentNode = this
	}

	contains(node: RenderContainer | null): boolean {
		if (node === null) return false
		if (this === node) return true
		return this.childNodes.some((child) => child.contains(node))
	}

	get isConnected() {
		if (this === this.ownerDocument.body) return true
		return this.parentNode?.isConnected ?? false
	}
}

class TestTextNode extends TestNode {
	readonly nodeType = 3
	data: string

	constructor(ownerDocument: TestDocument, data: string) {
		super(ownerDocument)
		this.data = data
	}

	override get textContent() {
		return this.data
	}

	override set textContent(value: string) {
		this.data = value
	}
}

class TestElement extends TestNode {
	readonly nodeType = 1
	tagName: string
	nodeName: string
	attributes: AttributeMap = {}
	readonly eventListeners = new Map<string, Set<(event: TestEvent) => void>>()
	style = {
		setProperty: (name: string, value: string) => {
			this.style[name] = value
		},
		removeProperty: (name: string) => {
			delete this.style[name]
		},
		getPropertyValue: (name: string) => this.style[name] ?? '',
	} as Record<string, string> & {
		setProperty: (name: string, value: string) => void
		removeProperty: (name: string) => void
		getPropertyValue: (name: string) => string
	}

	constructor(ownerDocument: TestDocument, tagName: string) {
		super(ownerDocument)
		this.tagName = tagName.toUpperCase()
		this.nodeName = this.tagName
	}

	setAttribute(name: string, value: string) {
		this.attributes[name] = value
	}

	removeAttribute(name: string) {
		delete this.attributes[name]
	}

	addEventListener(type: string, listener: (event: TestEvent) => void) {
		const listeners = this.eventListeners.get(type) ?? new Set()
		listeners.add(listener)
		this.eventListeners.set(type, listeners)
	}
	removeEventListener(type: string, listener: (event: TestEvent) => void) {
		this.eventListeners.get(type)?.delete(listener)
	}
	dispatchEvent(event: TestEvent) {
		event.target ??= this
		event.currentTarget = this
		event.stopPropagation ??= () => { event.cancelBubble = true }
		event.preventDefault ??= () => { event.defaultPrevented = true }
		const eventType = this.eventListeners.has(event.type)
			? event.type
			: [...this.eventListeners.keys()].find((registeredType) => registeredType.toLowerCase() === event.type.toLowerCase()) ?? event.type
		event.type = eventType
		for (const listener of this.eventListeners.get(eventType) ?? []) listener.call(this, event)
		if (event.bubbles === true && event.cancelBubble !== true && this.parentNode instanceof TestElement) this.parentNode.dispatchEvent(event)
		return event.cancelBubble !== true
	}
	querySelectorAll() {
		const matches: TestElement[] = []
		const collect = (node: TestNode) => {
			for (const child of node.childNodes) {
				if (child instanceof TestElement) {
					const tagName = child.tagName.toLowerCase()
					const isFormControl = ['button', 'input', 'select', 'textarea'].includes(tagName) && child.getAttribute('disabled') === null
					const isLink = child.getAttribute('href') !== null
					const tabIndex = child.getAttribute('tabindex') ?? child.getAttribute('tabIndex')
					if (isFormControl || isLink || (tabIndex !== null && tabIndex !== '-1')) matches.push(child)
				}
				collect(child)
			}
		}
		collect(this)
		return matches
	}
	closest(selector: string): TestElement | null {
		if (selector === '[inert], [aria-hidden="true"]' && (this.getAttribute('inert') !== null || this.getAttribute('aria-hidden') === 'true')) return this
		return this.parentNode instanceof TestElement ? this.parentNode.closest(selector) : null
	}
	focus() { this.ownerDocument.activeElement = this }
	blur() {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null
	}
	showPopover() { return undefined }
	hidePopover() { return undefined }
	togglePopover() { return undefined }

	getAttribute(name: string) {
		return this.attributes[name] ?? null
	}

	override get textContent() {
		return super.textContent
	}

	override set textContent(value: string) {
		super.textContent = value
	}
}

class TestDialogElement extends TestElement {
	open = false
	returnValue = ''

	showModal() {
		this.open = true
	}

	close(returnValue = '') {
		this.open = false
		this.returnValue = returnValue
		this.dispatchEvent({ type: 'close' })
	}
}

class TestDocument {
	activeElement: TestElement | null = null
	body: TestElement
	readonly dialogElementConstructor: typeof TestDialogElement

	constructor(dialogElementConstructor: typeof TestDialogElement = TestDialogElement) {
		this.dialogElementConstructor = dialogElementConstructor
		this.body = new TestElement(this, 'body')
	}

	addEventListener() { return undefined }
	removeEventListener() { return undefined }

	createElement(tagName: string) {
		if (tagName.toLowerCase() === 'dialog') return new this.dialogElementConstructor(this, tagName)
		return new TestElement(this, tagName)
	}

	createElementNS(_namespace: string, tagName: string) {
		return this.createElement(tagName)
	}

	createTextNode(data: string) {
		return new TestTextNode(this, data)
	}
}

type TestWindow = {
	document: TestDocument
	addEventListener(): undefined
	removeEventListener(): undefined
}

type DomMockState = {
	restored: boolean
	previousDocument: unknown
	previousWindow: unknown
	previousSetInterval: unknown
	previousClearInterval: unknown
	previousRequestAnimationFrame: unknown
	previousCancelAnimationFrame: unknown
	previousHtmlDialogElement: unknown
}

const fallbackDocument = new TestDocument()
const fallbackWindow: TestWindow = {
	document: fallbackDocument,
	addEventListener() { return undefined },
	removeEventListener() { return undefined },
}
const domMockOwners = new Map<unknown, DomMockState>()

function resolveRestorablePreviousValue(previousValue: unknown, fallbackValue: unknown, getPreviousValue: (state: DomMockState) => unknown): unknown {
	const owner = domMockOwners.get(previousValue)
	if (owner?.restored === true) return resolveRestorablePreviousValue(getPreviousValue(owner), fallbackValue, getPreviousValue)
	return previousValue ?? fallbackValue
}

function defineGlobalValue(name: string, value: unknown) {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function restoreOwnedGlobal(name: string, isOwnedByThisMock: boolean, previousValue: unknown, fallbackValue: unknown, getPreviousValue: (state: DomMockState) => unknown) {
	if (!isOwnedByThisMock) return
	defineGlobalValue(name, resolveRestorablePreviousValue(previousValue, fallbackValue, getPreviousValue))
}

export function installDomMock() {
	class OwnedTestDialogElement extends TestDialogElement {}
	const document = new TestDocument(OwnedTestDialogElement)
	const window: TestWindow = {
		document,
		addEventListener() { return undefined },
		removeEventListener() { return undefined },
	}
	const setIntervalMock: typeof globalThis.setInterval = () => 1
	const clearIntervalMock: typeof globalThis.clearInterval = () => undefined
	const requestAnimationFrameMock: typeof globalThis.requestAnimationFrame = (callback) => {
		callback(0)
		return 1
	}
	const cancelAnimationFrameMock: typeof globalThis.cancelAnimationFrame = () => undefined
	const previousDocument = globalThis.document
	const previousWindow = globalThis.window
	const previousSetInterval = globalThis.setInterval
	const previousClearInterval = globalThis.clearInterval
	const previousRequestAnimationFrame = globalThis.requestAnimationFrame
	const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
	const previousHtmlDialogElement = globalThis.HTMLDialogElement
	const state: DomMockState = {
		restored: false,
		previousDocument,
		previousWindow,
		previousSetInterval,
		previousClearInterval,
		previousRequestAnimationFrame,
		previousCancelAnimationFrame,
		previousHtmlDialogElement,
	}
	for (const ownedValue of [document, window, setIntervalMock, clearIntervalMock, requestAnimationFrameMock, cancelAnimationFrameMock, OwnedTestDialogElement]) domMockOwners.set(ownedValue, state)

	defineGlobalValue('document', document)
	defineGlobalValue('window', window)
	defineGlobalValue('setInterval', setIntervalMock)
	defineGlobalValue('clearInterval', clearIntervalMock)
	defineGlobalValue('requestAnimationFrame', requestAnimationFrameMock)
	defineGlobalValue('cancelAnimationFrame', cancelAnimationFrameMock)
	defineGlobalValue('HTMLDialogElement', OwnedTestDialogElement)

	return {
		document,
		restore() {
			// Bun runs test files concurrently. Do not remove another test's active DOM
			// or leave Preact cleanup with an undefined global document.
			state.restored = true
			restoreOwnedGlobal('document', globalThis.document === document, previousDocument, fallbackDocument, (owner) => owner.previousDocument)
			restoreOwnedGlobal('window', globalThis.window === window || globalThis.window?.document === document, previousWindow, fallbackWindow, (owner) => owner.previousWindow)
			restoreOwnedGlobal('setInterval', globalThis.setInterval === setIntervalMock, previousSetInterval, undefined, (owner) => owner.previousSetInterval)
			restoreOwnedGlobal('clearInterval', globalThis.clearInterval === clearIntervalMock, previousClearInterval, undefined, (owner) => owner.previousClearInterval)
			restoreOwnedGlobal('requestAnimationFrame', globalThis.requestAnimationFrame === requestAnimationFrameMock, previousRequestAnimationFrame, undefined, (owner) => owner.previousRequestAnimationFrame)
			restoreOwnedGlobal('cancelAnimationFrame', globalThis.cancelAnimationFrame === cancelAnimationFrameMock, previousCancelAnimationFrame, undefined, (owner) => owner.previousCancelAnimationFrame)
			restoreOwnedGlobal('HTMLDialogElement', globalThis.HTMLDialogElement === OwnedTestDialogElement, previousHtmlDialogElement, undefined, (owner) => owner.previousHtmlDialogElement)
		},
	}
}

export function installDateMock(initialNow: Date | string | number) {
	const RealDate = Date
	let currentNow = new RealDate(initialNow).getTime()

	class MockDate extends RealDate {
		constructor(value?: string | number | Date) {
			super(value === undefined ? currentNow : value)
		}

		static now() {
			return currentNow
		}

		static parse = RealDate.parse
		static UTC = RealDate.UTC
	}

	Object.defineProperty(globalThis, 'Date', { value: MockDate, configurable: true, writable: true })

	return {
		setNow(nextNow: Date | string | number) {
			currentNow = new RealDate(nextNow).getTime()
		},
		restore() {
			globalThis.Date = RealDate
		},
	}
}
