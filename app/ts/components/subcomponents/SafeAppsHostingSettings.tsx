import { useSignal } from '@preact/signals'
import { requestPopupPrepareSafeApp, requestPopupCancelPrepareSafeApp, sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport } from '../../background/backgroundUtils.js'
import { parseSafeAppsHostOrigin, SAFE_APPS_HOST_ORIGIN_LIMIT } from '../../types/safeAppsHosting.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from './AsyncAction.js'
import { ErrorComponent } from './Error.js'

function SafeAppsHostRow({ origin, enabled, removeDisabled, onRemove }: { origin: string, enabled: boolean, removeDisabled: boolean, onRemove: () => void }) {
	const { value: preparation, waitFor: waitForPreparation } = useAsyncState<void>()
	const { value: cancellation, waitFor: waitForCancellation } = useAsyncState<void>()
	return <li class = 'grid brief'>
		<strong class = 'truncate' title = { origin }>{ origin }</strong>
		<div class = 'actions'>
			<AsyncActionButton state = { preparation.value.state } disabled = { !enabled } text = 'Authorize and reload open tab' pendingText = 'Connecting…' onClick = { () => waitForPreparation(async () => await requestPopupPrepareSafeApp(origin)) } class = 'btn btn--primary' />
			{ preparation.value.state === 'pending' ? <AsyncActionButton state = { cancellation.value.state } text = 'Cancel connection' pendingText = 'Cancelling…' onClick = { () => waitForCancellation(async () => await requestPopupCancelPrepareSafeApp(origin)) } class = 'btn btn--outline' /> : <></> }
			<button type = 'button' class = 'btn btn--outline' disabled = { removeDisabled } onClick = { onRemove }>Remove</button>
		</div>
		{ preparation.value.state === 'rejected' ? <ErrorComponent text = { preparation.value.error.message } containerStyle = { { margin: '0', gridColumn: '1 / -1' } } /> : <></> }
		{ cancellation.value.state === 'rejected' ? <ErrorComponent text = { cancellation.value.error.message } containerStyle = { { margin: '0', gridColumn: '1 / -1' } } /> : <></> }
	</li>
}

export function SafeAppsHostingSettings({ enabled, origins }: { enabled: boolean, origins: readonly string[] }) {
	const website = useSignal('')
	const savingAction = useSignal<'add' | 'remove' | undefined>(undefined)
	const { value: save, waitFor: waitForSave } = useAsyncState<void>()
	const saveOrigins = async (next: readonly string[]) => {
		if (!enabled) throw new Error('Enable Safe Apps compatibility before changing websites.')
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_ChangeSettings', data: { safeAppsHostOrigins: next } })
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_requestSettings' })
	}
	return <div class = 'grid' style = '--gap-y: 0.5rem; --btn-text-size: 0.9rem; padding-block: 0.5rem'>
		<p class = 'paragraph'>Connect as a Safe App on these websites. Select a Safe in signing mode, open the website, then authorize and reload it before using its Safe connector. Site discovery deadlines remain unchanged and short probes may still time out after approval.</p>
		<p class = 'paragraph'>Supports apps using parent-based Safe SDK discovery. Apps requiring a real iframe or a trusted Safe parent origin need additional support.</p>
		{ origins.length > 0 ? <ul class = 'grid' style = '--gap-y: 0.5rem'>
			{ origins.map((origin) => <SafeAppsHostRow key = { origin } origin = { origin } enabled = { enabled } removeDisabled = { !enabled || save.value.state === 'pending' } onRemove = { () => {
				savingAction.value = 'remove'
				waitForSave(async () => await saveOrigins(origins.filter((existing) => existing !== origin)))
			} } />) }
		</ul> : <></> }
		<div class = 'grid' style = '--grid-cols: minmax(0, 1fr) max-content; --gap-x: 0.5rem'>
			<label class = 'grid paragraph' style = '--grid-cols: max-content minmax(0, 1fr); --gap-x: 0.5rem'>
				<span>Website URL</span>
				<input class = 'input' type = 'url' value = { website.value } placeholder = 'https://app.example.com' disabled = { !enabled } onInput = { (event) => { website.value = event.currentTarget.value } } />
			</label>
			<AsyncActionButton state = { savingAction.value === 'add' ? save.value.state : 'inactive' } disabled = { !enabled || save.value.state === 'pending' || website.value.trim() === '' || origins.length >= SAFE_APPS_HOST_ORIGIN_LIMIT } text = 'Add website' pendingText = 'Saving…' class = 'btn btn--outline' onClick = { () => {
				savingAction.value = 'add'
				waitForSave(async () => {
					const origin = parseSafeAppsHostOrigin(website.value.trim())
					if (!origins.includes(origin)) await saveOrigins([...origins, origin])
					website.value = ''
				})
			} } />
		</div>
		{ save.value.state === 'rejected' ? <ErrorComponent text = { save.value.error.message } containerStyle = { { margin: '0' } } /> : <></> }
	</div>
}
