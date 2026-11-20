import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'
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
	const errorId = useId()
	const rawValue = formatUnits(amount, decimals)
	return <div class = 'rich-mode-amount-cell'>
		<div class = 'rich-mode-amount-with-unit'>
			<input
				autoFocus = { autoFocus }
				class = 'input is-small'
				aria-describedby = { error === undefined ? undefined : errorId }
				aria-invalid = { error === undefined ? undefined : 'true' }
				aria-label = { label }
				disabled = { disabled }
				value = { focused.value ? rawValue : formatRichAmountForDisplay(amount, decimals) }
				onFocus = { event => {
					focused.value = true
					const input = event.currentTarget
					globalThis.queueMicrotask(() => { if (typeof input.select === 'function') input.select() })
				} }
				onBlur = { () => { focused.value = false } }
				onChange = { event => { onCommit(event.currentTarget) } }
			/>
			<span class = 'rich-mode-amount-unit' aria-hidden = 'true'>{ unit }</span>
			<button type = 'button' class = 'rich-mode-reset-amount' aria-label = { `Reset ${ unit } rich amount to ${ formatRichAmountForDisplay(defaultAmount, decimals) }` } data-tooltip = 'Reset to default' disabled = { disabled || amount === defaultAmount } onClick = { onReset }>↺</button>
		</div>
		{ error === undefined ? <></> : <small id = { errorId } class = 'rich-mode-amount-error' role = 'alert'>{ error }</small> }
	</div>
}
