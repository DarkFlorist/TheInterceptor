import { render } from 'preact'

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

	addEventListener() {}
	removeEventListener() {}
	showPopover() {}
	hidePopover() {}
	togglePopover() {}

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

export function installDomMock() {
	const document = new TestDocument()
	const previousDocument = globalThis.document
	const previousWindow = globalThis.window
	const previousSetInterval = globalThis.setInterval
	const previousClearInterval = globalThis.clearInterval
	const previousRequestAnimationFrame = globalThis.requestAnimationFrame
	const previousCancelAnimationFrame = globalThis.cancelAnimationFrame

	// @ts-expect-error test shim intentionally overrides the DOM globals
	globalThis.document = document
	// @ts-expect-error test shim intentionally overrides the DOM globals
	globalThis.window = { document }
	// @ts-expect-error test shim intentionally overrides the timer globals
	globalThis.setInterval = () => 1
	globalThis.clearInterval = () => undefined
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		callback(0)
		return 1
	})
	globalThis.cancelAnimationFrame = () => undefined

	return {
		document,
		restore() {
			globalThis.document = previousDocument
			globalThis.window = previousWindow
			globalThis.setInterval = previousSetInterval
			globalThis.clearInterval = previousClearInterval
			globalThis.requestAnimationFrame = previousRequestAnimationFrame
			globalThis.cancelAnimationFrame = previousCancelAnimationFrame
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

	// @ts-expect-error test shim intentionally overrides the global Date constructor
	globalThis.Date = MockDate

	return {
		setNow(nextNow: Date | string | number) {
			currentNow = new RealDate(nextNow).getTime()
		},
		restore() {
			globalThis.Date = RealDate
		},
	}
}
