import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { getErrorMessage } from '../../utils/errors.js'
import { AsyncActionButton } from './AsyncAction.js'
import { clipboardCopy } from './clipboardcopy.js'
import { DinoSaysNotification } from './DinoSays.js'
import { ErrorComponent } from './Error.js'
import { useAsyncState } from '../../utils/preact-utilities.js'

export function CopySafeTransactionsButton({
	class: className = 'button is-small',
	onCopyStart,
	onCopyError,
	text = 'Copy Gnosis Safe transactions',
}: {
	readonly class?: string
	readonly onCopyStart?: () => void
	readonly onCopyError?: (message: string) => void
	readonly text?: ComponentChildren
}) {
	const { value: copyState, waitFor: waitForCopy } = useAsyncState<void>()
	const copied = useSignal(false)

	const copySafeTransactions = async () => {
		copied.value = false
		onCopyStart?.()
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestSafeStackExport' })
			if (reply === undefined) throw new Error('Interceptor did not reply to the Gnosis Safe transaction copy request.')
			if (!reply.ok) throw new Error(reply.message)
			await clipboardCopy(reply.safeStackJson)
			copied.value = true
		} catch (error) {
			onCopyError?.(getErrorMessage(error) ?? 'Failed to copy Interceptor Gnosis Safe transactions.')
			throw error
		}
	}

	return <div class = 'copy-safe-transactions-button'>
		<AsyncActionButton
			class = { className }
			state = { copyState.value.state }
			onClick = { () => { void waitForCopy(copySafeTransactions) } }
			text = { text }
			pendingText = 'Copying Gnosis Safe transactions...'
		/>
		{ copied.value
			? <DinoSaysNotification text = 'Copied Interceptor Gnosis Safe transactions.' close = { () => { copied.value = false } }/>
			: <></> }
		{ onCopyError === undefined && copyState.value.state === 'rejected'
			? <ErrorComponent text = { getErrorMessage(copyState.value.error) ?? 'Failed to copy Interceptor Gnosis Safe transactions.' }/>
			: <></> }
	</div>
}
