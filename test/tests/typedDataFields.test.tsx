import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { TypedDataFields } from '../../app/ts/components/subcomponents/TypedDataFields.js'
import { installDomMock } from './domMock.js'

test('typed-data field presentation preserves large integers, whitespace and nested array structure', () => {
	const dom = installDomMock()
	try {
		act(() => render(h(TypedDataFields, { fields: { amount: '900719925474099312345', message: ' line one\nline two ', empty: '', approved: false, recipients: [{ name: 'Alice', amounts: ['1', '2'] }] } }), dom.document.body))
		const text = dom.document.body.textContent
		expect(text).toContain('900719925474099312345')
		expect(text).toContain(' line one\nline two ')
		expect(text).toContain('""')
		expect(text).toContain('false')
		expect(text).toContain(JSON.stringify([{ name: 'Alice', amounts: ['1', '2'] }], undefined, 2))
	} finally { dom.restore() }
})
