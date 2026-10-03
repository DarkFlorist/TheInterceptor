import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeAppsHostingSettings } from '../../app/ts/components/subcomponents/SafeAppsHostingSettings.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly tagName?: string
	readonly textContent?: string
	readonly hasAttribute?: (name: string) => boolean
}

function findElement(node: TestNode, tagName: string, text?: string): TestNode | undefined {
	if (node.tagName === tagName && (text === undefined || node.textContent?.includes(text))) return node
	for (const child of node.childNodes ?? []) {
		const found = findElement(child, tagName, text)
		if (found !== undefined) return found
	}
	return undefined
}

test('Safe Apps website edits require compatibility to be enabled', async () => {
	const dom = installDomMock()
	try {
		await act(() => { render(h(SafeAppsHostingSettings, { enabled: false, origins: ['https://host.example'] }), dom.document.body) })
		for (const text of ['Authorize and reload open tab', 'Remove', 'Add website']) {
			assert.equal(findElement(dom.document.body, 'BUTTON', text)?.hasAttribute?.('disabled'), true)
		}
		assert.equal(findElement(dom.document.body, 'INPUT')?.hasAttribute?.('disabled'), true)

		await act(() => { render(h(SafeAppsHostingSettings, { enabled: true, origins: ['https://host.example'] }), dom.document.body) })
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Authorize and reload open tab')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'BUTTON', 'Remove')?.hasAttribute?.('disabled'), false)
		assert.equal(findElement(dom.document.body, 'INPUT')?.hasAttribute?.('disabled'), false)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})
