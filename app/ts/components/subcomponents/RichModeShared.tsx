import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'
import type { RichTokenBalance, RichTokenOption } from '../../types/richMode.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { sameRichTokenIdentity } from '../../utils/richTokens.js'

// A balance is shown as funded only while its token option has a stored layout (enabled); without one the simulation cannot fund it.
export const findFundedRichTokenOption = (options: readonly RichTokenOption[], balance: RichTokenBalance) => options.find((option) => option.enabled && sameRichTokenIdentity(option, balance))

export function RichTokenIcon({ label, logoUri, class: className }: { label: string, logoUri: string | undefined, class: string }) {
	return logoUri === undefined
		? <span class = { `${ className } rich-mode-token-monogram` } aria-hidden = 'true'>{ label.slice(0, 2) }</span>
		: <img class = { className } src = { logoUri } width = '20' height = '20' aria-hidden = 'true'/>
}

export function RichBalanceRow({ action, balance, class: className, label, logoUri, name }: {
	action?: ComponentChildren
	balance: ComponentChildren
	class?: string
	label: string
	logoUri: string | undefined
	name: string
}) {
	return <div class = { `rich-mode-balance-row${ className === undefined ? '' : ` ${ className }` }` }>
		<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { label } logoUri = { logoUri }/>
		<span class = 'rich-mode-balance-token-name'><strong>{ label }</strong><small>{ name }</small></span>
		{ balance }
		{ action ?? <span/> }
	</div>
}

export function formatRichAmountForDisplay(amount: bigint, decimals: number) {
	const [integer = '0', fraction] = formatUnits(amount, decimals).split('.')
	const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
	return fraction === undefined ? groupedInteger : `${ groupedInteger }.${ fraction }`
}

// Marks a control whose click must not first commit an amount being edited (reset, remove token, dialog close and backdrop). The rich-mode dialog cancels mousedown on these so focus stays in the field; otherwise the blur commit would mark a save pending and disable the control before its click arrives.
export const KEEPS_AMOUNT_EDIT_SELECTOR = '[data-keeps-amount-edit], [data-dialog-close], [data-dialog-backdrop]'

// An edited amount (the draft) is committed when focus leaves the field or on Enter. Reset discards the draft and saves the default only when the saved amount differs from it, and a draft still open when the field unmounts (closing the dialog or removing the token) is discarded, as Escape always did.
export function RichAmountEditor({ amount, autoFocus = false, defaultAmount, decimals, disabled, error, label, onCommit, onReset, unit }: {
	amount: bigint
	autoFocus?: boolean
	defaultAmount: bigint
	decimals: number
	disabled: boolean
	error: string | undefined
	label: string
	onCommit: (input: HTMLInputElement) => void
	onReset: () => void
	unit: string
}) {
	const focused = useSignal(false)
	const draft = useSignal<string | undefined>(undefined)
	const unmounted = useRef(false)
	const errorId = useId()
	const rawValue = formatUnits(amount, decimals)
	const defaultRawValue = formatUnits(defaultAmount, decimals)
	const savedAmountIsDefault = amount === defaultAmount
	const resetChangesSomething = !savedAmountIsDefault || (draft.value !== undefined && draft.value.trim() !== defaultRawValue)
	useEffect(() => () => { unmounted.current = true }, [])
	const commitEdit = (input: HTMLInputElement) => {
		if (draft.value === undefined || unmounted.current) return
		draft.value = undefined
		onCommit(input)
	}
	const discardDraftAndReset = () => {
		draft.value = undefined
		if (!savedAmountIsDefault) onReset()
	}
	return <div class = 'rich-mode-amount-cell'>
		<div class = 'rich-mode-amount-with-unit'>
			<input
				autoFocus = { autoFocus }
				class = 'input is-small'
				aria-describedby = { error === undefined ? undefined : errorId }
				aria-invalid = { error === undefined ? undefined : 'true' }
				aria-label = { label }
				disabled = { disabled }
				value = { draft.value ?? (focused.value ? rawValue : formatRichAmountForDisplay(amount, decimals)) }
				onFocus = { event => {
					focused.value = true
					const input = event.currentTarget
					globalThis.queueMicrotask(() => { if (typeof input.select === 'function') input.select() })
				} }
				onInput = { event => { draft.value = event.currentTarget.value } }
				onKeyDown = { event => { if (event.key === 'Enter') commitEdit(event.currentTarget) } }
				onBlur = { event => {
					focused.value = false
					commitEdit(event.currentTarget)
				} }
			/>
			<span class = 'rich-mode-amount-unit' aria-hidden = 'true'>{ unit }</span>
			<button type = 'button' class = 'rich-mode-reset-amount' aria-label = { `Reset ${ unit } rich amount to ${ formatRichAmountForDisplay(defaultAmount, decimals) }` } data-tooltip = 'Reset to default' disabled = { disabled || !resetChangesSomething } data-keeps-amount-edit = '' onClick = { discardDraftAndReset }>↺</button>
		</div>
		{ error === undefined ? <></> : <small id = { errorId } class = 'rich-mode-amount-error' role = 'alert'>{ error }</small> }
	</div>
}
