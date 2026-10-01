import { useSignal } from '@preact/signals'
import { requestPopupPrepareSafeApp, requestPopupCancelPrepareSafeApp, sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport } from '../../background/backgroundUtils.js'
import { parseSafeAppsHostOrigin } from '../../types/safeAppsHosting.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from './AsyncAction.js'
import { ErrorComponent } from './Error.js'

export function SafeAppsHostingSettings({ enabled, origins }: { enabled: boolean, origins: readonly string[] }) {
	const website = useSignal('')
	const connectingOrigin = useSignal<string | undefined>(undefined)
	const { value: cancellation, waitFor: waitForCancellation } = useAsyncState<void>()
	const { value: action, waitFor } = useAsyncState<void>()
	const saveOrigins = async (next: readonly string[]) => {
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_ChangeSettings', data: { safeAppsHostOrigins: next } })
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_requestSettings' })
	}
	return <div class = 'container'>
		<p class = 'paragraph'>Connect as a Safe App on these websites. Select a Safe in signing mode, open the website, then authorize and reload it before using its Safe connector. Site discovery deadlines remain unchanged and short probes may still time out after approval.</p>
		<p class = 'paragraph'>Supports apps using parent-based Safe SDK discovery. Apps requiring a real iframe or a trusted Safe parent origin need additional support.</p>
		{ origins.map((origin) => <div key = { origin } class = 'row' style = 'gap: 0.5rem; margin-block: 0.5rem;'>
			<span>{ origin }</span>
			<AsyncActionButton state = { action.value.state } disabled = { !enabled } text = 'Authorize and reload open tab' pendingText = 'Connecting…' onClick = { () => waitFor(async () => {
				connectingOrigin.value = origin
				try { await requestPopupPrepareSafeApp(origin) } finally { connectingOrigin.value = undefined }
			}) } class = 'button is-primary' />
			{ connectingOrigin.value === origin ? <AsyncActionButton state = { cancellation.value.state } text = 'Cancel connection' pendingText = 'Cancelling…' onClick = { () => waitForCancellation(async () => await requestPopupCancelPrepareSafeApp(origin)) } class = 'button' /> : <></> }
			<button type = 'button' class = 'button' disabled = { action.value.state === 'pending' } onClick = { () => waitFor(async () => await saveOrigins(origins.filter((existing) => existing !== origin))) }>Remove</button>
		</div>) }
		<label>Website URL <input type = 'url' value = { website.value } placeholder = 'https://app.example.com' onInput = { (event) => { website.value = event.currentTarget.value } } /></label>
		<AsyncActionButton state = { action.value.state } disabled = { website.value.trim() === '' || origins.length >= 32 } text = 'Add website' pendingText = 'Saving…' class = 'button' onClick = { () => waitFor(async () => {
			const origin = parseSafeAppsHostOrigin(website.value.trim())
			if (!origins.includes(origin)) await saveOrigins([...origins, origin])
			website.value = ''
		}) } />
		{ cancellation.value.state === 'rejected' ? <ErrorComponent text = { cancellation.value.error.message } /> : <></> }
		{ action.value.state === 'rejected' ? <ErrorComponent text = { action.value.error.message } /> : <></> }
	</div>
}
