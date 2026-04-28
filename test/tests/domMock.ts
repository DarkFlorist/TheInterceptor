import { render } from 'preact'

type AttributeMap = Record<string, string | undefined>
type RenderContainer = Parameters<typeof render>[1]

type TestNodeKind = 'node' | 'text' | 'element'

type BaseTestNode = {
	kind: TestNodeKind
	nodeType: number
	parentNode: TestNode | null
	childNodes: TestNode[]
	ownerDocument: TestDocument
	appendChild(node: RenderContainer): TestNode
	insertBefore(node: RenderContainer, before: RenderContainer | null): TestNode
	removeChild(node: RenderContainer): TestNode
	replaceChild(node: RenderContainer, oldNode: RenderContainer): TestNode
	contains(node: RenderContainer | null): boolean
	readonly firstChild: TestNode | null
	textContent: string
}

type TestStyle = Record<string, string> & {
	setProperty(name: string, value: string): void
	removeProperty(name: string): void
	getPropertyValue(name: string): string
}

type TestTextNode = BaseTestNode & {
	kind: 'text'
	nodeType: 3
	data: string
}

type TestElement = BaseTestNode & {
	kind: 'element'
	nodeType: 1
	tagName: string
	nodeName: string
	attributes: AttributeMap
	style: TestStyle
	setAttribute(name: string, value: string): void
	removeAttribute(name: string): void
	addEventListener(): void
	removeEventListener(): void
	showPopover(): void
	hidePopover(): void
	togglePopover(): void
	getAttribute(name: string): string | null
}

type TestNode = BaseTestNode | TestTextNode | TestElement

type TestDocument = {
	body: TestElement
	createElement(tagName: string): TestElement
	createElementNS(namespace: string, tagName: string): TestElement
	createTextNode(data: string): TestTextNode
}

const isTestNode = (node: RenderContainer | null): node is TestNode => {
	if (typeof node !== 'object' || node === null) return false
	if (!('kind' in node) || !('nodeType' in node) || !('ownerDocument' in node)) return false
	return node.kind === 'node' || node.kind === 'text' || node.kind === 'element'
}

const createBaseNode = (ownerDocument: TestDocument): BaseTestNode => ({
	kind: 'node',
	nodeType: 0,
	parentNode: null,
	childNodes: [],
	ownerDocument,
	appendChild(node: RenderContainer) {
		if (!isTestNode(node)) throw new Error('Expected TestNode')
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes.push(node)
		return node
	},
	insertBefore(node: RenderContainer, before: RenderContainer | null) {
		if (!isTestNode(node)) throw new Error('Expected TestNode')
		if (before === null || before === undefined) return this.appendChild(node)
		if (!isTestNode(before)) throw new Error('Expected TestNode')
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		const index = this.childNodes.indexOf(before)
		if (index < 0) return this.appendChild(node)
		this.childNodes.splice(index, 0, node)
		return node
	},
	removeChild(node: RenderContainer) {
		if (!isTestNode(node)) throw new Error('Expected TestNode')
		const index = this.childNodes.indexOf(node)
		if (index >= 0) this.childNodes.splice(index, 1)
		node.parentNode = null
		return node
	},
	replaceChild(node: RenderContainer, oldNode: RenderContainer) {
		if (!isTestNode(node) || !isTestNode(oldNode)) throw new Error('Expected TestNode')
		const index = this.childNodes.indexOf(oldNode)
		if (index < 0) return this.appendChild(node)
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes[index] = node
		oldNode.parentNode = null
		return oldNode
	},
	get firstChild() {
		return this.childNodes[0] ?? null
	},
	get textContent() {
		return this.childNodes.map((node) => node.textContent).join('')
	},
	set textContent(value: string) {
		this.childNodes = value === '' ? [] : [createTextNode(this.ownerDocument, value)]
		for (const node of this.childNodes) node.parentNode = this
	},
	contains(node: RenderContainer | null) {
		if (!isTestNode(node)) return false
		if (this === node) return true
		return this.childNodes.some((child) => child.contains(node))
	},
})

const createTextNode = (ownerDocument: TestDocument, initialData: string): TestTextNode => {
	let data = initialData
	const node = createBaseNode(ownerDocument)
	Object.assign(node, {
		kind: 'text' as const,
		nodeType: 3,
	})
	return Object.defineProperties(node, {
		data: {
			configurable: true,
			enumerable: true,
			get() {
				return data
			},
			set(value: string) {
				data = value
			},
		},
		textContent: {
			configurable: true,
			enumerable: true,
			get() {
				return data
			},
			set(value: string) {
				data = value
			},
		},
	}) as TestTextNode
}

const createStyle = (): TestStyle => {
	const styleValues: Record<string, string> = {}
	return Object.assign(styleValues, {
		setProperty(name: string, value: string) {
			styleValues[name] = value
		},
		removeProperty(name: string) {
			delete styleValues[name]
		},
		getPropertyValue(name: string) {
			return styleValues[name] ?? ''
		},
	})
}

const createElement = (ownerDocument: TestDocument, tagName: string): TestElement => Object.assign(
	createBaseNode(ownerDocument),
	{
		kind: 'element' as const,
		nodeType: 1,
		tagName: tagName.toUpperCase(),
		nodeName: tagName.toUpperCase(),
		attributes: {},
		style: createStyle(),
		setAttribute(name: string, value: string) {
			this.attributes[name] = value
		},
		removeAttribute(name: string) {
			delete this.attributes[name]
		},
		addEventListener() {},
		removeEventListener() {},
		showPopover() {},
		hidePopover() {},
		togglePopover() {},
		getAttribute(name: string) {
			return this.attributes[name] ?? null
		},
	},
)

const createDocument = (): TestDocument => {
	let body: TestElement | undefined = undefined
	const document: TestDocument = {
		get body() {
			if (body === undefined) throw new Error('Document body was not initialized')
			return body
		},
		createElement(tagName: string) {
			return createElement(document, tagName)
		},
		createElementNS(_namespace: string, tagName: string) {
			return document.createElement(tagName)
		},
		createTextNode(data: string) {
			return createTextNode(document, data)
		},
	}
	body = createElement(document, 'body')
	return document
}

const setGlobal = (property: keyof typeof globalThis, value: unknown) => {
	Object.defineProperty(globalThis, property, {
		configurable: true,
		writable: true,
		value,
	})
}

export function installDomMock() {
	const document = createDocument()
	const fakeWindow = { document }
	const previousDocument = globalThis.document
	const previousWindow = globalThis.window
	const previousSetInterval = globalThis.setInterval
	const previousClearInterval = globalThis.clearInterval
	const previousRequestAnimationFrame = globalThis.requestAnimationFrame
	const previousCancelAnimationFrame = globalThis.cancelAnimationFrame

	setGlobal('document', document)
	setGlobal('window', fakeWindow)
	setGlobal('setInterval', () => 1)
	setGlobal('clearInterval', () => undefined)
	setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		callback(0)
		return 1
	})
	setGlobal('cancelAnimationFrame', () => undefined)

	return {
		document,
		restore() {
			setGlobal('document', previousDocument)
			setGlobal('window', previousWindow)
			setGlobal('setInterval', previousSetInterval)
			setGlobal('clearInterval', previousClearInterval)
			setGlobal('requestAnimationFrame', previousRequestAnimationFrame)
			setGlobal('cancelAnimationFrame', previousCancelAnimationFrame)
		},
	}
}

export function installDateMock(initialNow: Date | string | number) {
	const RealDate = Date
	let currentNow = new RealDate(initialNow).getTime()

	function MockDate(value?: string | number | Date) {
		if (new.target === undefined) return new RealDate(currentNow).toString()
		return new RealDate(value === undefined ? currentNow : value)
	}

	Object.setPrototypeOf(MockDate, RealDate)
	Object.defineProperty(MockDate, 'prototype', { value: RealDate.prototype })
	Object.defineProperty(MockDate, 'now', { value: () => currentNow })
	Object.defineProperty(MockDate, 'parse', { value: RealDate.parse })
	Object.defineProperty(MockDate, 'UTC', { value: RealDate.UTC })

	setGlobal('Date', MockDate)

	return {
		setNow(nextNow: Date | string | number) {
			currentNow = new RealDate(nextNow).getTime()
		},
		restore() {
			setGlobal('Date', RealDate)
		},
	}
}
