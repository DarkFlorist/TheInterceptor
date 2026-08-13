import type { render } from 'preact'

type AttributeMap = Record<string, string | undefined>
type RenderContainer = Parameters<typeof render>[1]

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
	clientHeight = 40
	onscroll: unknown = undefined
	scrollTop = 0
	attributes: AttributeMap = {}
	readonly eventListeners = new Map<string, Set<(event: Event) => unknown>>()
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

	addEventListener(type: string, listener: (event: Event) => unknown) {
		const listeners = this.eventListeners.get(type) ?? new Set()
		listeners.add(listener)
		this.eventListeners.set(type, listeners)
	}

	removeEventListener(type: string, listener: (event: Event) => unknown) {
		this.eventListeners.get(type)?.delete(listener)
	}

	dispatchEvent(event: Event) {
		if (event.target === null) Object.defineProperty(event, 'target', { configurable: true, value: this })
		Object.defineProperty(event, 'currentTarget', { configurable: true, value: this })
		for (const listener of this.eventListeners.get(event.type) ?? []) listener.call(this, event)
		if (event.bubbles && !event.cancelBubble && this.parentNode instanceof TestElement) this.parentNode.dispatchEvent(event)
		return !event.defaultPrevented
	}
	focus() { return undefined }
	blur() { return undefined }
	showPopover() { return undefined }
	hidePopover() { return undefined }
	togglePopover() { return undefined }
	getBoundingClientRect() { return { height: this.clientHeight, width: 100, x: 0, y: 0, top: 0, right: 100, bottom: this.clientHeight, left: 0 } }

	getAttribute(name: string) {
		return this.attributes[name] ?? null
	}

	hasAttribute(name: string) {
		return this.attributes[name] !== undefined
	}

	closest(selector: string): TestElement | null {
		const attributeMatch = selector.match(/^\[([^\]]+)\]$/u)
		if (attributeMatch?.[1] === undefined) return null
		let element: TestElement | null = this
		while (element !== null) {
			if (element.hasAttribute(attributeMatch[1])) return element
			element = element.parentNode instanceof TestElement ? element.parentNode : null
		}
		return null
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
	readonly eventListeners = new Map<string, Set<(event: { currentTarget: TestDialogElement }) => void>>()

	override addEventListener(type: string, listener: (event: { currentTarget: TestDialogElement }) => void) {
		const listeners = this.eventListeners.get(type) ?? new Set()
		listeners.add(listener)
		this.eventListeners.set(type, listeners)
	}

	override removeEventListener(type: string, listener: (event: { currentTarget: TestDialogElement }) => void) {
		this.eventListeners.get(type)?.delete(listener)
	}

	showModal() {
		this.open = true
	}

	close(returnValue = '') {
		this.open = false
		this.returnValue = returnValue
		for (const listener of this.eventListeners.get('close') ?? []) listener({ currentTarget: this })
	}
}

class TestDocument {
	body: TestElement
	readonly elementConstructor: new (ownerDocument: TestDocument, tagName: string) => TestElement
	readonly dialogElementConstructor: new (ownerDocument: TestDocument, tagName: string) => TestElement

	constructor(
		elementConstructor: new (ownerDocument: TestDocument, tagName: string) => TestElement = TestElement,
		dialogElementConstructor: new (ownerDocument: TestDocument, tagName: string) => TestElement = TestDialogElement,
	) {
		this.elementConstructor = elementConstructor
		this.dialogElementConstructor = dialogElementConstructor
		this.body = new this.elementConstructor(this, 'body')
	}

	addEventListener() { return undefined }
	removeEventListener() { return undefined }

	createElement(tagName: string) {
		if (tagName.toLowerCase() === 'dialog') return new this.dialogElementConstructor(this, tagName)
		return new this.elementConstructor(this, tagName)
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
	previousHtmlDivElement: unknown
	previousElement: unknown
}

const fallbackDocument = new TestDocument()
const fallbackWindow: TestWindow = {
	document: fallbackDocument,
	addEventListener() { return undefined },
	removeEventListener() { return undefined },
}
const fallbackRequestAnimationFrame: typeof globalThis.requestAnimationFrame = (callback) => {
	const timeout = setTimeout(() => callback(performance.now()), 0)
	return Number(timeout)
}
const fallbackCancelAnimationFrame: typeof globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
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
	class OwnedTestElement extends TestElement {}
	class OwnedTestDialogElement extends OwnedTestElement {
		open = false
		returnValue = ''

		showModal() {
			this.open = true
		}

		close(returnValue = '') {
			this.open = false
			this.returnValue = returnValue
			this.dispatchEvent(new Event('close'))
		}
	}
	const document = new TestDocument(OwnedTestElement, OwnedTestDialogElement)
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
	const previousHtmlDivElement = globalThis.HTMLDivElement
	const previousElement = globalThis.Element
	const state: DomMockState = {
		restored: false,
		previousDocument,
		previousWindow,
		previousSetInterval,
		previousClearInterval,
		previousRequestAnimationFrame,
		previousCancelAnimationFrame,
		previousHtmlDialogElement,
		previousHtmlDivElement,
		previousElement,
	}
	for (const ownedValue of [document, window, setIntervalMock, clearIntervalMock, requestAnimationFrameMock, cancelAnimationFrameMock, OwnedTestDialogElement, OwnedTestElement]) domMockOwners.set(ownedValue, state)

	defineGlobalValue('document', document)
	defineGlobalValue('window', window)
	defineGlobalValue('setInterval', setIntervalMock)
	defineGlobalValue('clearInterval', clearIntervalMock)
	defineGlobalValue('requestAnimationFrame', requestAnimationFrameMock)
	defineGlobalValue('cancelAnimationFrame', cancelAnimationFrameMock)
	defineGlobalValue('HTMLDialogElement', OwnedTestDialogElement)
	defineGlobalValue('HTMLDivElement', OwnedTestElement)
	defineGlobalValue('Element', OwnedTestElement)

	return {
		document,
		restore() {
			// Bun runs test files concurrently. Do not remove another test's active DOM or leave Preact cleanup with an undefined global document.
			state.restored = true
			restoreOwnedGlobal('document', globalThis.document === document, previousDocument, fallbackDocument, (owner) => owner.previousDocument)
			restoreOwnedGlobal('window', globalThis.window === window || globalThis.window?.document === document, previousWindow, fallbackWindow, (owner) => owner.previousWindow)
			restoreOwnedGlobal('setInterval', globalThis.setInterval === setIntervalMock, previousSetInterval, undefined, (owner) => owner.previousSetInterval)
			restoreOwnedGlobal('clearInterval', globalThis.clearInterval === clearIntervalMock, previousClearInterval, undefined, (owner) => owner.previousClearInterval)
			restoreOwnedGlobal('requestAnimationFrame', globalThis.requestAnimationFrame === requestAnimationFrameMock, previousRequestAnimationFrame, fallbackRequestAnimationFrame, (owner) => owner.previousRequestAnimationFrame)
			restoreOwnedGlobal('cancelAnimationFrame', globalThis.cancelAnimationFrame === cancelAnimationFrameMock, previousCancelAnimationFrame, fallbackCancelAnimationFrame, (owner) => owner.previousCancelAnimationFrame)
			restoreOwnedGlobal('HTMLDialogElement', globalThis.HTMLDialogElement === OwnedTestDialogElement, previousHtmlDialogElement, undefined, (owner) => owner.previousHtmlDialogElement)
			restoreOwnedGlobal('HTMLDivElement', globalThis.HTMLDivElement === OwnedTestElement, previousHtmlDivElement, undefined, (owner) => owner.previousHtmlDivElement)
			restoreOwnedGlobal('Element', globalThis.Element === OwnedTestElement, previousElement, undefined, (owner) => owner.previousElement)
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
