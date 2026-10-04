import { useComputed, type Signal } from '@preact/signals'
import { SafeStackExport } from '../../types/safeTypes.js'
import { isJSON } from '../../utils/json.js'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { Notice } from '../subcomponents/Error.js'
import { XMarkIcon } from '../subcomponents/icons.js'

export function ImportSafeStack({ close, safeStackInput }: {
	readonly close: () => void
	readonly safeStackInput: Signal<string>
}) {
	const { value: importState, waitFor: waitForImport } = useAsyncState<void>()
	const inputError = useComputed(() => {
		const trimmed = safeStackInput.value.trim()
		if (trimmed.length === 0) return undefined
		if (!isJSON(trimmed)) return 'The Gnosis Safe stack is not valid JSON.'
		const parsed = SafeStackExport.safeParse(JSON.parse(trimmed))
		return parsed.success ? undefined : `The input is not an Interceptor Gnosis Safe Stack: ${ parsed.message }`
	})
	const replyError = useComputed(() => importState.value.state === 'rejected' ? importState.value.error.message : undefined)

	const importStack = () => {
		void waitForImport(async () => {
			const payload = SafeStackExport.parse(JSON.parse(safeStackInput.peek().trim()))
			const reply = await sendPopupMessageWithReply({ method: 'popup_importSafeStack', data: payload })
			if (reply === undefined) throw new Error('Interceptor did not reply to the Gnosis Safe stack import request.')
			if (!reply.ok) throw new Error(reply.message)
			close()
		})
	}

	return <>
		<div class = 'modal-background'></div>
		<div class = 'modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-title'><p class = 'paragraph'>Import Interceptor Gnosis Safe Stack</p></div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { close } disabled = { importState.value.state === 'pending' }><XMarkIcon /></button>
			</header>
			<section class = 'modal-card-body'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color);'>Paste the stack returned by the Gnosis Safe co-signer application. Transaction fields must match the local stack; only valid owner signatures are merged.</p>
						<textarea
							class = { `simulation-stack-import-input${ inputError.value === undefined ? '' : ' simulation-stack-import-input-invalid' }` }
							value = { safeStackInput.value }
							onInput = { (event) => { safeStackInput.value = event.currentTarget.value } }
							disabled = { importState.value.state === 'pending' }
							spellcheck = { false }
						/>
					</div>
				</div>
				{ inputError.value !== undefined ? <Notice text = { inputError.value } /> : replyError.value !== undefined ? <Notice text = { replyError.value } /> : <></> }
			</section>
			<footer class = 'modal-card-foot window-footer'>
				<AsyncActionButton
					class = 'button is-success is-primary'
					state = { importState.value.state }
					text = 'Import signatures'
					pendingText = 'Validating...'
					onClick = { importStack }
					disabled = { safeStackInput.value.trim().length === 0 || inputError.value !== undefined }
				/>
			</footer>
		</div>
	</>
}
