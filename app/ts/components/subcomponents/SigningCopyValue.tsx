import { useEffect, useRef, useState } from 'preact/hooks'
import { clipboardCopy } from './clipboardcopy.js'
import { reportUnexpectedError } from '../../utils/errors.js'

/** A real keyboard-accessible button, with durable feedback independent of pointer tooltips. */
export function SigningCopyValue({ value, label }: { value: string, label: string }) {
	const [copied, setCopied] = useState(false)
	const [error, setError] = useState(false)
	const [busy, setBusy] = useState(false)
	const copying = useRef(false)
	useEffect(() => { setCopied(false); setError(false) }, [value])
	const copy = async () => {
		if (copying.current) return
		copying.current = true
		setBusy(true)
		setCopied(false)
		setError(false)
		try {
			await clipboardCopy(value)
			setCopied(true)
		} catch (failure) {
			setError(true)
			if (!(failure instanceof DOMException && failure.name === 'NotAllowedError')) await reportUnexpectedError(failure)
		} finally { copying.current = false; setBusy(false) }
	}
	return <span class = 'signing-copy-value'>
		<span class = 'signing-address'>{ value }</span>
		<button type = 'button' class = 'button signing-secondary signing-copy-button' aria-label = { `Copy ${ label }` } aria-disabled = { busy } aria-busy = { busy } onClick = { copy }>{ copied ? 'Copied' : 'Copy' }</button>
		<span class = { error ? 'signing-copy-feedback' : 'signing-screen-reader' } role = 'status' aria-atomic = 'true'>{ error ? `Could not copy ${ label }. Select the text and copy it manually, or try again.` : copied ? `${ label } copied to clipboard.` : '' }</span>
	</span>
}
