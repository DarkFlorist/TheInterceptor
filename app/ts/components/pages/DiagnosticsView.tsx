import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import type { InterceptorErrorDiagnostic } from '../../types/errorDiagnostics.js'
import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { clipboardCopy } from '../subcomponents/clipboardcopy.js'
import { formatDiagnosticsForClipboard, summarizeDiagnostics } from '../../utils/diagnostics.js'

function DiagnosticCard({ diagnostic }: { diagnostic: InterceptorErrorDiagnostic }) {
	const metadata = [diagnostic.source, diagnostic.code, diagnostic.category].join(' · ')
	return <li class = { `diagnostics-card diagnostics-card--${ diagnostic.severity }` }>
		<header class = 'diagnostics-card-header'>
			<div>
				<strong>{ diagnostic.message }</strong>
				<p>{ metadata }</p>
			</div>
			<div class = 'diagnostics-card-time'>
				<span class = { `diagnostics-severity diagnostics-severity--${ diagnostic.severity }` }>{ diagnostic.severity }</span>
				<time dateTime = { diagnostic.timestamp.toISOString() }>{ diagnostic.timestamp.toLocaleString() }</time>
			</div>
		</header>
		{ diagnostic.cause === undefined && diagnostic.details === undefined && diagnostic.debugId === undefined ? <></> :
			<details class = 'diagnostics-details'>
				<summary>Technical details</summary>
				{ diagnostic.cause === undefined ? <></> : <div><strong>Cause</strong><pre>{ diagnostic.cause }</pre></div> }
				{ diagnostic.details === undefined ? <></> : <div><strong>Context</strong><pre>{ diagnostic.details }</pre></div> }
				{ diagnostic.debugId === undefined ? <></> : <p><strong>Debug ID:</strong> <code>{ diagnostic.debugId }</code></p> }
			</details>
		}
	</li>
}

export function DiagnosticsView() {
	const diagnostics = useSignal<readonly InterceptorErrorDiagnostic[]>([])
	const { value: loadState, waitFor: waitForLoad } = useAsyncState<void>()
	const { value: copyState, waitFor: waitForCopy } = useAsyncState<void>()
	const { value: clearState, waitFor: waitForClear } = useAsyncState<void>()
	const summary = summarizeDiagnostics(diagnostics.value)

	async function loadDiagnostics() {
		const reply = await sendPopupMessageWithReply({ method: 'popup_requestDiagnostics' })
		if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Loading diagnostics'))
		diagnostics.value = reply.diagnostics
	}

	async function clearDiagnostics() {
		if (!globalThis.confirm('Clear all stored diagnostics?')) return
		const reply = await sendPopupMessageWithReply({ method: 'popup_clearDiagnostics' })
		if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Clearing diagnostics'))
		diagnostics.value = reply.diagnostics
	}

	async function copyDiagnostics() {
		await clipboardCopy(formatDiagnosticsForClipboard(diagnostics.peek()))
	}

	useEffect(() => { void waitForLoad(loadDiagnostics) }, [])

	const loadError = loadState.value.state === 'rejected' ? loadState.value.error.message : undefined
	const copyError = copyState.value.state === 'rejected' ? copyState.value.error.message : undefined
	const clearError = clearState.value.state === 'rejected' ? clearState.value.error.message : undefined
	const newestFirst = [...diagnostics.value].reverse()

	return <main class = 'diagnostics-page'>
		<header class = 'diagnostics-header'>
			<div>
				<h1>Diagnostics</h1>
				<p>The latest internal errors and recovered failures. The Interceptor retains up to 50 records.</p>
			</div>
			<div class = 'diagnostics-actions'>
				<AsyncActionButton class = 'btn btn--outline' state = { loadState.value.state } onClick = { () => { void waitForLoad(loadDiagnostics) } } text = 'Refresh' pendingText = 'Refreshing...' />
				<AsyncActionButton class = 'btn btn--outline' state = { copyState.value.state } disabled = { diagnostics.value.length === 0 } onClick = { () => { void waitForCopy(copyDiagnostics) } } text = 'Copy diagnostics' pendingText = 'Copying...' />
				<AsyncActionButton class = 'btn btn--destructive' state = { clearState.value.state } disabled = { diagnostics.value.length === 0 } onClick = { () => { void waitForClear(clearDiagnostics) } } text = 'Clear diagnostics' pendingText = 'Clearing...' />
			</div>
		</header>
		{ loadError === undefined ? <></> : <ErrorComponent warning = { true } text = { loadError } /> }
		{ copyError === undefined ? <></> : <ErrorComponent warning = { true } text = { copyError } /> }
		{ clearError === undefined ? <></> : <ErrorComponent warning = { true } text = { clearError } /> }
		<section class = 'diagnostics-summary' aria-label = 'Diagnostic summary'>
			<div><strong>{ summary.total }</strong><span>Total</span></div>
			<div><strong>{ summary.error }</strong><span>Errors</span></div>
			<div><strong>{ summary.warning }</strong><span>Warnings</span></div>
			<div><strong>{ summary.info }</strong><span>Info</span></div>
		</section>
		{ loadState.value.state === 'pending' && diagnostics.value.length === 0 ? <p class = 'diagnostics-empty'>Loading diagnostics...</p>
		: diagnostics.value.length === 0 ? <p class = 'diagnostics-empty'>No diagnostics have been recorded.</p>
		: <ol class = 'diagnostics-list'>
			{ newestFirst.map((diagnostic, index) => <DiagnosticCard key = { `${ diagnostic.timestamp.valueOf() }-${ diagnostic.code }-${ index }` } diagnostic = { diagnostic } />) }
		</ol> }
	</main>
}
