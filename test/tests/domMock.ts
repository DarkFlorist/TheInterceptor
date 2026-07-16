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
	attributes: AttributeMap = {}
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

	addEventListener() { return undefined }
	removeEventListener() { return undefined }
	focus() { return undefined }
	blur() { return undefined }
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

class TestDocument {
	body: TestElement

	constructor() {
		this.body = new TestElement(this, 'body')
	}

	addEventListener() { return undefined }
	removeEventListener() { return undefined }

	createElement(tagName: string) {
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
	const document = new TestDocument()
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
	const state: DomMockState = {
		restored: false,
		previousDocument,
		previousWindow,
		previousSetInterval,
		previousClearInterval,
		previousRequestAnimationFrame,
		previousCancelAnimationFrame,
	}
	for (const ownedValue of [document, window, setIntervalMock, clearIntervalMock, requestAnimationFrameMock, cancelAnimationFrameMock]) domMockOwners.set(ownedValue, state)

	defineGlobalValue('document', document)
	defineGlobalValue('window', window)
	defineGlobalValue('setInterval', setIntervalMock)
	defineGlobalValue('clearInterval', clearIntervalMock)
	defineGlobalValue('requestAnimationFrame', requestAnimationFrameMock)
	defineGlobalValue('cancelAnimationFrame', cancelAnimationFrameMock)

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
