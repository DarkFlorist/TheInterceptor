import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { getSomeTimeAgoText, SomeTimeAgo } from '../../app/ts/components/subcomponents/SomeTimeAgo.js'

type AttributeMap = Record<string, string | undefined>

class TestNode {
	parentNode: TestNode | null = null
	childNodes: TestNode[] = []
	ownerDocument: TestDocument

	constructor(ownerDocument: TestDocument) {
		this.ownerDocument = ownerDocument
	}

	appendChild(node: TestNode) {
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes.push(node)
		return node
	}

	insertBefore(node: TestNode, before: TestNode | null) {
		if (before === null || before === undefined) return this.appendChild(node)
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		const index = this.childNodes.indexOf(before)
		if (index < 0) return this.appendChild(node)
		this.childNodes.splice(index, 0, node)
		return node
	}

	removeChild(node: TestNode) {
		const index = this.childNodes.indexOf(node)
		if (index >= 0) this.childNodes.splice(index, 1)
		node.parentNode = null
		return node
	}

	replaceChild(node: TestNode, oldNode: TestNode) {
		const index = this.childNodes.indexOf(oldNode)
		if (index < 0) return this.appendChild(node)
		if (node.parentNode !== null) node.parentNode.removeChild(node)
		node.parentNode = this
		this.childNodes[index] = node
		oldNode.parentNode = null
		return oldNode
	}

	get firstChild() {
		return this.childNodes[0]
	}

	get textContent(): string {
		return this.childNodes.map((node) => node.textContent).join('')
	}

	set textContent(value: string) {
		this.childNodes = value === '' ? [] : [new TestTextNode(this.ownerDocument, value)]
		for (const node of this.childNodes) node.parentNode = this
	}
}

class TestTextNode extends TestNode {
	nodeType = 3
	data: string

	constructor(ownerDocument: TestDocument, data: string) {
		super(ownerDocument)
		this.data = data
	}

	get textContent() {
		return this.data
	}

	set textContent(value: string) {
		this.data = value
	}
}

class TestElement extends TestNode {
	nodeType = 1
	tagName: string
	nodeName: string
	attributes: AttributeMap = {}
	style: Record<string, string> = {}

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

	getAttribute(name: string) {
		return this.attributes[name] ?? null
	}

	get textContent() {
		return super.textContent
	}

	set textContent(value: string) {
		super.textContent = value
	}

	contains(node: TestNode): boolean {
		if (this === node) return true
		return this.childNodes.some((child) => child === node || (child instanceof TestElement && child.contains(node)))
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

async function main() {
	describe('SomeTimeAgo', () => {
		should('recomputes the displayed age when the timestamp moves forward', () => {
			const now = new Date('2024-01-01T00:00:10.000Z')
			const formatSeconds = (secondsDiff: number) => `${ Math.round(secondsDiff) }s`
			const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
			const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')
			assert.equal(getSomeTimeAgoText(olderTimestamp, now, false, formatSeconds), '5s')
			assert.equal(getSomeTimeAgoText(newerTimestamp, now, false, formatSeconds), '1s')
		})

		should('updates the rendered output when rerendered with a fresher timestamp', async () => {
			const dom = installDomMock()
			const formatSeconds = (secondsDiff: number) => `${ Math.round(secondsDiff) }s`
			const olderTimestamp = new Date('2024-01-01T00:00:05.000Z')
			const newerTimestamp = new Date('2024-01-01T00:00:09.000Z')

			await act(() => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(SomeTimeAgo, { priorTimestamp: olderTimestamp, diffToText: formatSeconds }), dom.document.body)
			})
			assert.equal(dom.document.body.textContent, '5s')

			await act(() => {
				// @ts-expect-error test shim uses a lightweight container
				render(h(SomeTimeAgo, { priorTimestamp: newerTimestamp, diffToText: formatSeconds }), dom.document.body)
			})
			assert.equal(dom.document.body.textContent, '1s')

			dom.restore()
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
