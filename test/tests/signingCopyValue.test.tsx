import { expect, spyOn, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SigningCopyValue } from '../../app/ts/components/subcomponents/SigningCopyValue.js'
import * as clipboard from '../../app/ts/components/subcomponents/clipboardcopy.js'
import * as errors from '../../app/ts/utils/errors.js'
import { clickRenderedElement, findRenderedElement, installDomMock } from './domMock.js'

for (const name of ['NotAllowedError', 'InvalidStateError']) {
	test(`copy recovery classifies ${ name } without suppressing unexpected reports`, async () => {
		const dom = installDomMock()
		const failure = new DOMException('Clipboard fixture failure', name)
		const copy = spyOn(clipboard, 'clipboardCopy').mockRejectedValue(failure)
		const report = spyOn(errors, 'reportUnexpectedError').mockResolvedValue(undefined)
		try {
			act(() => render(h(SigningCopyValue, { value: '0x1234', label: 'acting address' }), dom.document.body))
			const button = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON')
			if (button === undefined) throw new Error('Copy button is missing')
			await act(async () => { await clickRenderedElement(button) })
			expect(copy).toHaveBeenCalledWith('0x1234')
			expect(dom.document.body.textContent).toContain('copy it manually')
			if (name === 'NotAllowedError') expect(report).not.toHaveBeenCalled()
			else expect(report).toHaveBeenCalledWith(failure)
		} finally { copy.mockRestore(); report.mockRestore(); dom.restore() }
	})
}
