import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { TypedDataFields } from '../../app/ts/components/subcomponents/TypedDataFields.js'
import { findRenderedElement, installDomMock } from './domMock.js'

test('typed-data fields preserve scalar values and lazily disclose nested arrays and structs', () => {
	const dom = installDomMock()
	try {
		act(() => render(h(TypedDataFields, { fields: { amount: '900719925474099312345', message: ' line one\nline two ', empty: '', approved: false, recipients: [{ name: 'Alice', amounts: ['1', '2'] }] } }), dom.document.body))
		const text = dom.document.body.textContent
		expect(text).toContain('900719925474099312345')
		expect(text).toContain(' line one\nline two ')
		expect(text).toContain('""')
		expect(text).toContain('false')
		expect(text).toContain('Array · 1 item')
		expect(text).not.toContain('Alice')
		for (let level = 0; level < 3; level++) {
			const details = findRenderedElement(dom.document.body, (node) => node.tagName === 'DETAILS' && node.childNodes?.length === 1)
			const toggle = details?.l === undefined ? undefined : Object.entries(details.l).find(([key]) => key.startsWith('Toggle'))?.[1]
			if (toggle === undefined) throw new Error('Expected expandable nested field')
			act(() => toggle({ currentTarget: { open: true } }))
		}
		expect(dom.document.body.textContent).toContain('Alice')
		expect(dom.document.body.textContent).toContain('[0]1')
		expect(dom.document.body.textContent).toContain('[1]2')
	} finally { dom.restore() }
})
