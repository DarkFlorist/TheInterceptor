import type { ComponentChildren } from 'preact'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { getErrorMessage } from '../../utils/errors.js'
import { AsyncActionButton } from './AsyncAction.js'
import { clipboardCopy } from './clipboardcopy.js'
import { ErrorComponent } from './Error.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { Tooltip } from './Tooltip.js'
import { useCopyFeedback } from '../hooks/useCopyFeedback.js'

export function CopySafeTransactionsButton({
	class: className = 'button is-small',
	onCopyStart,
	onCopyError,
	text = 'Copy Gnosis Safe transactions',
	disabled = false,
	disabledTitle,
	ariaLabel,
	pendingText = 'Copying Gnosis Safe transactions...',
}: {
	readonly class?: string
	readonly onCopyStart?: () => void
	readonly onCopyError?: (message: string) => void
	readonly text?: ComponentChildren
	readonly disabled?: boolean
	readonly disabledTitle?: string
	readonly ariaLabel?: string
	readonly pendingText?: string
}) {
	const { value: copyState, waitFor: waitForCopy } = useAsyncState<void>()
	const { coolingDown, tooltip, showCopied } = useCopyFeedback()

	const copySafeTransactions = async (copyPosition: { x: number, y: number }) => {
		onCopyStart?.()
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestSafeStackExport' })
			if (reply === undefined) throw new Error('Interceptor did not reply to the Gnosis Safe transaction copy request.')
			if (!reply.ok) throw new Error(reply.message)
			await clipboardCopy(reply.safeStackJson)
			showCopied(copyPosition)
		} catch (error) {
			onCopyError?.(getErrorMessage(error) ?? 'Failed to copy Interceptor Gnosis Safe transactions.')
			throw error
		}
	}

	return <div class = 'copy-safe-transactions-button'>
		<AsyncActionButton
			class = { className }
			state = { copyState.value.state }
			disabled = { disabled || coolingDown.value }
			title = { disabled ? disabledTitle : undefined }
			ariaLabel = { ariaLabel }
			onClick = { (event) => {
				const copyPosition = { x: event.clientX, y: event.clientY }
				void waitForCopy(async () => await copySafeTransactions(copyPosition))
			} }
			text = { text }
			pendingText = { pendingText }
			keepTextWhilePending = { true }
			pendingIndicatorPlacement = 'overlay'
		/>
		<Tooltip config = { tooltip } />
		{ onCopyError === undefined && copyState.value.state === 'rejected'
			? <ErrorComponent text = { getErrorMessage(copyState.value.error) ?? 'Failed to copy Interceptor Gnosis Safe transactions.' }/>
			: <></> }
	</div>
}
