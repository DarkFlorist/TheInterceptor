import type { HomeParams, FirstCardParams, SimulationStateParam, RenameAddressCallBack, TabState } from '../../types/user-interface-types.js'
import { type SimulationAndVisualisationResults, isEmptySimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { ActiveAddressComponent, AddressIcon, SmallAddress, WebsiteOriginText, getActiveAddressEntry } from '../subcomponents/address.js'
import { SimulationSummary } from '../simulationExplaining/SimulationSummary.js'
import { TransactionsAndSignedMessages } from '../simulationExplaining/Transactions.js'
import { ICON_ACTIVE, ICON_INTERCEPTOR_DISABLED, ICON_NOT_ACTIVE, ICON_NOT_ACTIVE_WITH_SHIELD } from '../../utils/constants.js'
import { getPrettySignerName, SignerLogoText, SignersLogoName } from '../subcomponents/signers.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { ToolTip } from '../subcomponents/CopyToClipboard.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { DinoSays } from '../subcomponents/DinoSays.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import type { TransactionOrMessageIdentifier } from '../../types/interceptor-messages.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { BroomIcon, ChevronIcon, OpenInNewIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'
import { RpcSelector } from '../subcomponents/ChainSelector.js'
import { type Signal, type ReadonlySignal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useEffect, useId, useRef } from 'preact/hooks'
import { type DeltaUnit, TimePicker, type TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { assertNever } from '../../utils/typescript.js'
import { addressString, bigintSecondsToDate } from '../../utils/bigint.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getDefaultRichTokenAmount, getMatchingRichTokenOptions, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { truncateAddr } from '../../utils/ethereum.js'
import { useResetSimulation } from '../hooks/useResetSimulation.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import type { ComponentChildren, JSX } from 'preact'
import { DropDownMenuButtonContent } from '../subcomponents/DropDownMenu.js'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'

function scheduleAfterPaint(callback: () => void) {
	if (typeof globalThis.requestAnimationFrame === 'function' && typeof globalThis.cancelAnimationFrame === 'function') {
		let secondFrame: number | undefined
		const firstFrame = globalThis.requestAnimationFrame(() => {
			secondFrame = globalThis.requestAnimationFrame(() => callback())
		})
		return () => {
			globalThis.cancelAnimationFrame(firstFrame)
			if (secondFrame !== undefined) globalThis.cancelAnimationFrame(secondFrame)
		}
	}
	const timeout = globalThis.setTimeout(callback, 32)
	return () => globalThis.clearTimeout(timeout)
}

type LoadingControlProps = {
	class: string
	children: ComponentChildren
	style?: JSX.CSSProperties | string
}

function LoadingControl({ class: className, children, style }: LoadingControlProps) {
	return <button type = 'button' disabled = { true } tabIndex = { -1 } class = { `${ className } popup-loading-shape popup-loading-control` } style = { style }>
		<span class = 'popup-loading-control-content'>{ children }</span>
	</button>
}

function LoadingInput() {
	return <input
		aria-hidden = 'true'
		class = 'input popup-loading-shape popup-loading-control popup-loading-input'
		disabled = { true }
		tabIndex = { -1 }
		style = 'width: 50px; margin-right: 10px; vertical-align: unset; text-align: center;'
		type = 'number'
		value = ''
	/>
}

function LoadingDropdownControl({ label }: { label: string }) {
	return <div class = 'dropdown'>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<LoadingControl class = 'btn btn--outline is-small' style = { { width: '100%' } }>
				<DropDownMenuButtonContent label = { label }/>
			</LoadingControl>
		</div>
	</div>
}

function OpenSimulationStackButtonContent() {
	return <>
		<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
			<OpenInNewIcon/>
		</span>
		<span>View stack details</span>
	</>
}

function ClearSimulationButtonContent() {
	return <>
		<span style = { { marginRight: '0.25rem', fontSize: '1rem', width: '1em', height: '1em' } }>
			<BroomIcon />
		</span>
		<span>Clear</span>
	</>
}

function HomeHeaderLoadingSkeleton() {
	return <header aria-hidden = 'true' class = 'px-3 py-2 popup-home-header-layout'>
		<div>
			<span class = 'popup-loading-shape popup-loading-home-icon'/>
		</div>
		<div>
			<div class = 'buttons has-addons popup-home-mode-selector popup-loading-mode-selector'>
				<LoadingControl class = 'button is-primary'>Simulating</LoadingControl>
				<LoadingControl class = 'button is-primary'>
					<SignerLogoText signerName = 'NoSignerDetected' text = 'Signing' reserveLogoSpace = { true } />
				</LoadingControl>
			</div>
		</div>
		<div class = 'popup-home-rpc-selector'>
			<LoadingDropdownControl label = 'No RPC Selected'/>
		</div>
	</header>
}

function ActiveAddressLoadingSkeleton({ ariaLabel }: { ariaLabel?: string }) {
	return <div
		aria-busy = { ariaLabel === undefined ? undefined : true }
		aria-hidden = { ariaLabel === undefined ? true : undefined }
		aria-label = { ariaLabel }
		role = { ariaLabel === undefined ? undefined : 'status' }
		class = 'log-table active-address-row popup-loading-address'
	>
		<div aria-hidden = 'true' class = 'log-cell' style = 'display: block;'>
			<figure class = 'multiline-card popup-loading-address-details'>
				<span class = 'popup-loading-shape popup-loading-address-icon'/>
				<span class = 'popup-loading-shape popup-loading-address-title'/>
				<span class = 'popup-loading-shape popup-loading-address-subtitle'/>
			</figure>
		</div>
		<div aria-hidden = 'true' class = 'log-cell'>
			<div class = 'media-right'>
				<LoadingControl class = 'button is-primary'>Change</LoadingControl>
			</div>
		</div>
	</div>
}

function InlineLoadingSkeleton({ ariaLabel }: { ariaLabel: string }) {
	return <span aria-busy = 'true' aria-label = { ariaLabel } role = 'status' class = 'popup-home-connection-status popup-loading-inline-skeleton'>
		<span aria-hidden = 'true' class = 'popup-loading-shape'/>
	</span>
}

function SimulationControlsLoadingSkeleton() {
	return <div aria-busy = 'true' aria-label = 'Loading simulation controls' role = 'status' class = 'popup-simulation-controls popup-loading-controls'>
		<header aria-hidden = 'true' class = 'card-header popup-loading-rich-list-header'>
			<span class = 'popup-loading-shape'/>
		</header>
		<div aria-hidden = 'true' class = 'popup-simulation-controls-gap'/>
		<div aria-hidden = 'true'>
			<div class = 'time-picker-row'>
				<span class = 'popup-loading-shape popup-loading-time-picker-label'/>
				<div class = 'time-picker-actions'>
					<LoadingDropdownControl label = 'For'/>
					<div>
						<LoadingInput/>
						<LoadingDropdownControl label = 'Seconds'/>
					</div>
					<LoadingControl class = 'btn is-small is-primary'>Commit</LoadingControl>
				</div>
			</div>
		</div>
	</div>
}

function SimulationLoadingSkeleton() {
	return <div aria-busy = 'true' aria-label = 'Loading current simulation state' role = 'status' class = 'popup-loading-simulation'>
		<div aria-hidden = 'true' class = 'simulation-results-header'>
			<div class = 'log-cell'>
				<span class = 'popup-loading-shape popup-loading-simulation-title'/>
			</div>
			<div class = 'log-cell' style = 'justify-content: right; gap: 6px;'>
				<LoadingControl class = 'btn btn--outline is-small'>
					<OpenSimulationStackButtonContent/>
				</LoadingControl>
				<LoadingControl class = 'btn is-small is-danger'>
					<ClearSimulationButtonContent/>
				</LoadingControl>
			</div>
		</div>
		<section aria-hidden = 'true' class = 'card simulation-summary-card'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'popup-loading-shape popup-loading-simulation-icon'/>
				</div>
				<div class = 'card-header-title'>
					<span class = 'popup-loading-shape popup-loading-simulation-card-title'/>
				</div>
			</header>
			<div class = 'card-content popup-loading-simulation-content'>
				<span class = 'popup-loading-shape'/>
				<span class = 'popup-loading-shape'/>
				<span class = 'popup-loading-shape'/>
			</div>
		</section>
	</div>
}

function HomeLoadingSkeleton() {
	return <section aria-busy = 'true' aria-label = 'Loading current popup state' role = 'status' class = 'card popup-home-card'>
		<HomeHeaderLoadingSkeleton/>
		<div class = 'card-content'>
			<ActiveAddressLoadingSkeleton/>
		</div>
	</section>
}

type SignerExplanationParams = {
	activeAddress: Signal<AddressBookEntry | undefined>
	tabState: Signal<TabState | undefined>
}

function isSignerAvailable(tabState: TabState | undefined) {
	return tabState !== undefined && (tabState.signerConnected || tabState.signerAccounts.length > 0)
}

function SignerExplanation(param: SignerExplanationParams) {
	if (param.activeAddress.value !== undefined || param.tabState.value === undefined || param.tabState.value.signerAccountError !== undefined) return <></>
	if (!isSignerAvailable(param.tabState.value)) {
		if (param.tabState.value.signerName === 'NoSignerDetected' || param.tabState.value.signerName === 'NoSigner') return <ErrorComponent text = 'No signer installed. You need to install a signer, eg. Metamask.'/>
		return <ErrorComponent text = 'The page you are looking at has NOT CONNECTED to a wallet.'/>
	}
	return <ErrorComponent text = { `No account connected (or wallet is locked) in ${ param.tabState.value.signerName === 'NoSigner' ? 'signer' : getPrettySignerName(param.tabState.value.signerName) }.` }/>
}

function FirstCardHeader(param: FirstCardParams) {
	const tabIconReason = useComputed(() => param.tabIconDetails.value.iconReason)
	const signerName = useComputed(() => param.tabState.value?.signerName ?? 'NoSignerDetected')
	const { value: setSimulatingState, waitFor: waitForSetSimulating } = useAsyncState<void>()
	const { value: setSigningState, waitFor: waitForSetSigning } = useAsyncState<void>()
	const simulatingPending = setSimulatingState.value.state === 'pending'
	const signingPending = setSigningState.value.state === 'pending'

	async function enableSimulationMode(enabled: boolean ) {
		if (!param.isInitialHomeDataLoaded.value) return
		await sendPopupMessageToBackgroundPage( { method: 'popup_enableSimulationMode', data: enabled } )
	}
	const enableSimulating = () => {
		void waitForSetSimulating(() => enableSimulationMode(true))
	}
	const enableSigning = () => {
		void waitForSetSigning(() => enableSimulationMode(false))
	}

	return <>
		<header class = 'px-3 py-2 popup-home-header-layout'>
			<div>
				<ToolTip content = { tabIconReason }>
					<img class = 'noselect nopointer' src = { param.tabIconDetails.value.icon } width = '48' height = '48' style = { { display: 'block', width: '3rem', height: '3rem' } } />
				</ToolTip>
			</div>
			<div>
				<div class = 'buttons has-addons popup-home-mode-selector'>
					<AsyncActionButton
						class = { `button is-primary ${ param.simulationMode.value ? '' : 'is-outlined' }` }
						style = { `margin-bottom: 0px; border-color: transparent; ${ param.simulationMode.value ? 'opacity: 1;' : '' }` }
						state = { setSimulatingState.value.state }
						disabled = { param.simulationMode.value || signingPending || !param.isInitialHomeDataLoaded.value }
						keepTextWhilePending = { true }
						pendingIndicatorPlacement = 'overlay'
						pendingText = 'Switching to simulating mode...'
						text = 'Simulating'
						onClick = { enableSimulating }
					/>
					<AsyncActionButton
						class = { `button is-primary ${ param.simulationMode.value ? 'is-outlined' : ''}` }
						style = { `margin-bottom: 0px; border-color: transparent; ${ param.simulationMode.value ? '' : 'opacity: 1;' }` }
						state = { setSigningState.value.state }
						disabled = { !param.simulationMode.value || simulatingPending || !param.isInitialHomeDataLoaded.value }
						keepTextWhilePending = { true }
						pendingIndicatorPlacement = 'overlay'
						text = { <SignerLogoText signerName = { signerName } text = 'Signing' reserveLogoSpace = { true } /> }
						pendingText = 'Switching to signing mode...'
						onClick = { enableSigning }
					/>
				</div>
			</div>
			<div class = 'popup-home-rpc-selector'>
				<RpcSelector rpcEntries = { param.rpcEntries } rpcNetwork = { param.rpcNetwork } changeRpc = { param.changeActiveRpc } disabled = { !param.isInitialHomeDataLoaded.value }/>
			</div>
		</header>
	</>
}

type InterceptorDisabledButtonParams = {
	disableInterceptorToggle: (disabled: boolean) => Promise<void>,
	interceptorDisabled: Signal<boolean>,
	website: ReadonlySignal<Website | undefined>
	isInitialHomeDataLoaded: Signal<boolean>
}

function InterceptorDisabledButton({ disableInterceptorToggle, interceptorDisabled, website, isInitialHomeDataLoaded }: InterceptorDisabledButtonParams) {
	const { value: disableButtonState, waitFor: waitForDisableInterceptor } = useAsyncState<void>()
	const toggleInterceptor = () => {
		if (!isInitialHomeDataLoaded.value) return
		void waitForDisableInterceptor(() => disableInterceptorToggle(!interceptorDisabled.value))
	}

	return <AsyncActionButton
		disabled = { website.value === undefined || !isInitialHomeDataLoaded.value }
		state = { disableButtonState.value.state }
		class = { `button is-small ${ interceptorDisabled.value ? 'is-success' : 'is-primary' }` }
		text = { interceptorDisabled.value ? <>
			<span class = 'icon'> <img src = { ICON_ACTIVE } width = '24' height = '24'/> </span>
			<span> Enable</span>
		</> : <>
			<span class = 'icon'> <img src = { ICON_INTERCEPTOR_DISABLED } width = '24' height = '24'/> </span>
			<span> Disable</span>
		</> }
		pendingText = { interceptorDisabled.value ? 'Enabling interceptor...' : 'Disabling interceptor...' }
		onClick = { toggleInterceptor }
	/>
}

type RichListParams = {
	makeCurrentAddressRich: Signal<boolean>
	richNativeAmount: Signal<bigint>
	nativeCurrencyTicker: string
	activeAddress: Signal<AddressBookEntry | undefined>
	richList: Signal<readonly EnrichedRichListElement[]>
	richTokenOptions: Signal<readonly RichTokenOption[]>
	richAccountBalances: Signal<readonly RichAccountBalance[]>
	chainId: bigint
	renameAddressCallBack: RenameAddressCallBack
	isInitialHomeDataLoaded: Signal<boolean>
}

function RichTokenIcon({ label, logoUri, class: className }: { label: string, logoUri: string | undefined, class: string }) {
	return logoUri === undefined
		? <span class = { `${ className } rich-mode-token-monogram` } aria-hidden = 'true'>{ label.slice(0, 2) }</span>
		: <img class = { className } src = { logoUri } width = '20' height = '20' aria-hidden = 'true'/>
}

function formatRichAmountForDisplay(amount: bigint, decimals: number) {
	const [integer = '0', fraction] = formatUnits(amount, decimals).split('.')
	const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
	return fraction === undefined ? groupedInteger : `${ groupedInteger }.${ fraction }`
}

function RichAmountEditor({ amount, autoFocus = false, defaultAmount, decimals, disabled, error, label, onCommit, onReset, unit }: {
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

function HighlightedRichTokenText({ query, text }: { query: string, text: string }) {
	const normalizedQuery = query.trim().toLowerCase()
	const matchIndex = normalizedQuery === '' ? -1 : text.toLowerCase().indexOf(normalizedQuery)
	if (matchIndex === -1) return <>{ text }</>
	return <>{ text.slice(0, matchIndex) }<mark>{ text.slice(matchIndex, matchIndex + normalizedQuery.length) }</mark>{ text.slice(matchIndex + normalizedQuery.length) }</>
}

function RichBalanceSummary({ profile, tokenOptions, nativeCurrencyTicker }: {
	profile: RichAccountBalance | undefined
	tokenOptions: readonly RichTokenOption[]
	nativeCurrencyTicker: string
}) {
	if (profile === undefined) return <></>
	const tokenItems = profile.tokenBalances.flatMap((balance) => {
		const option = tokenOptions.find((candidate) => sameRichTokenIdentity(candidate, balance))
		return option === undefined ? [] : [{
			amount: formatRichAmountForDisplay(balance.amount, Number(option.decimals)),
			key: `${ option.tokenAddress.toString() }:${ option.tokenId?.toString() ?? 'erc20' }`,
			label: option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`,
			logoUri: option.logoUri,
		}]
	})
	const items = [{ amount: formatRichAmountForDisplay(profile.nativeAmount, 18), key: 'native', label: nativeCurrencyTicker, logoUri: nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }, ...tokenItems]
	const visibleItems = items.slice(0, 3)
	return <span class = 'rich-mode-balance-summary' aria-hidden = 'true'>
		{ visibleItems.map((item) => <span class = { `rich-mode-balance-summary-item${ item.key === 'native' ? ' is-native' : '' }` } title = { `${ item.label }: ${ item.amount }` } key = { item.key }>
			{ item.logoUri === undefined
				? <span class = 'rich-mode-balance-summary-monogram' aria-hidden = 'true'>{ item.label.slice(0, 2) }</span>
				: <img class = 'rich-mode-balance-summary-icon' src = { item.logoUri } width = '14' height = '14' aria-hidden = 'true'/>
			}
			<small>{ item.amount } { item.label }</small>
		</span>) }
		{ items.length <= visibleItems.length ? <></> : <span class = 'rich-mode-balance-summary-overflow'>+{ (items.length - visibleItems.length).toString() }</span> }
	</span>
}

function RichList({ makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, chainId, renameAddressCallBack, isInitialHomeDataLoaded }: RichListParams) {
	const selectRichTokensButtonRef = useRef<HTMLButtonElement>(null)
	async function enableMakeCurrentAddressRich(enabled: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: enabled, address: 'CurrentAddress'} } )
		makeCurrentAddressRich.value = enabled
		const address = activeAddress.value?.address
		if (enabled && address !== undefined && !richAccountBalances.value.some((profile) => profile.chainId === chainId && profile.address === address)) {
			richAccountBalances.value = [...richAccountBalances.value, { chainId, address, nativeAmount: richNativeAmount.value, tokenBalances: [] }]
		}
	}
	async function modifyRichList(addressBookEntry: AddressBookEntry, makeRich: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		richList.value = updateRichListAddress(
			richList.value,
			addressBookEntry.address,
			makeRich,
			(element) => element.addressBookEntry.address,
			() => ({ addressBookEntry, makingRich: true, type: 'UserAdded' as const }),
		)
		if (makeRich && !richAccountBalances.value.some((profile) => profile.chainId === chainId && profile.address === addressBookEntry.address)) {
			richAccountBalances.value = [...richAccountBalances.value, { chainId, address: addressBookEntry.address, nativeAmount: richNativeAmount.value, tokenBalances: [] }]
		}
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: makeRich, address: addressBookEntry.address } } )
	}

	const showList = useSignal<boolean>(false)
	const richAccountSearch = useSignal('')
	const richTokenError = useSignal<string | undefined>(undefined)
	const richTokenErrorTarget = useSignal<string | undefined>(undefined)
	const richTokenPending = useSignal(false)
	const richTokenPendingKey = useSignal<string | undefined>(undefined)
	const richTokenPendingLabel = useSignal<string | undefined>(undefined)
	const richTokenSaveConfirmedAddress = useSignal<bigint | undefined>(undefined)
	const richTokenSearch = useSignal('')
	const richTokenFilter = useSignal<'All' | 'ERC20' | 'ERC1155' | 'Ready' | 'NeedsScan'>('All')
	const highlightedRichTokenIndex = useSignal(0)
	const richTokenResultsScrollTop = useSignal(0)
	const recentRichTokenKeys = useSignal<readonly string[]>([])
	const showRichBalanceDialog = useSignal(false)
	const showRichTokenPicker = useSignal(false)
	const selectedRichTokenKeys = useSignal<readonly string[]>([])
	const addingRichTokenKeys = useSignal<readonly string[]>([])
	const failedAddedRichTokenKey = useSignal<string | undefined>(undefined)
	const newlyAddedRichTokenKeys = useSignal<readonly string[]>([])
	const selectedRichAddress = useSignal<bigint | undefined>(undefined)
	const getRichTokenLabel = (option: RichTokenOption) => option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`
	const getRichTokenKey = (option: RichTokenOption) => `${ option.tokenAddress.toString() }:${ option.tokenId?.toString() ?? 'erc20' }`
	const updateProfileForAddress = (address: bigint, update: (profile: RichAccountBalance) => RichAccountBalance) => {
		richAccountBalances.value = richAccountBalances.value.map((profile) => profile.chainId === chainId && profile.address === address ? update(profile) : profile)
	}
	useSignalEffect(() => {
		if (richTokenSaveConfirmedAddress.value === undefined) return
		const timeout = globalThis.setTimeout(() => { richTokenSaveConfirmedAddress.value = undefined }, 1600)
		return () => { globalThis.clearTimeout(timeout) }
	})
	useSignalEffect(() => {
		if (newlyAddedRichTokenKeys.value.length === 0) return
		const timeout = globalThis.setTimeout(() => { newlyAddedRichTokenKeys.value = [] }, 1800)
		return () => { globalThis.clearTimeout(timeout) }
	})
	const resetRichDialogViewState = () => {
		richTokenSearch.value = ''
		richTokenFilter.value = 'All'
		highlightedRichTokenIndex.value = 0
		richTokenResultsScrollTop.value = 0
		selectedRichTokenKeys.value = []
		addingRichTokenKeys.value = []
		failedAddedRichTokenKey.value = undefined
		newlyAddedRichTokenKeys.value = []
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
	}

	const setRichTokenEnabled = async (option: RichTokenOption, enabled: boolean, targetAddress?: bigint) => {
		const address = targetAddress ?? selectedRichAccount.value?.addressBookEntry.address
		if (richTokenPending.value || address === undefined) return false
		const tokenKey = getRichTokenKey(option)
		richTokenPending.value = true
		richTokenPendingKey.value = tokenKey
		richTokenSaveConfirmedAddress.value = undefined
		richTokenPendingLabel.value = enabled
			? `Preparing ${ getRichTokenLabel(option) }…`
			: `Removing ${ getRichTokenLabel(option) } from rich mode…`
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		const reply = await sendPopupMessageWithReply({
			method: 'popup_modifyRichToken',
			data: { action: enabled ? 'Add' : 'Remove', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId },
		})
		richTokenPending.value = false
		richTokenPendingKey.value = undefined
		richTokenPendingLabel.value = undefined
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return false
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
			richTokenErrorTarget.value = tokenKey
			return false
		}
		const configuredRichToken = reply.result.richToken
		if (configuredRichToken !== undefined) {
			richTokenOptions.value = richTokenOptions.value.map((entry) => sameRichTokenIdentity(entry, option) ? { ...entry, ...configuredRichToken, enabled: true } : entry)
		}
		updateProfileForAddress(address, (profile) => enabled
			? profile.tokenBalances.some((balance) => sameRichTokenIdentity(balance, option))
				? profile
				: { ...profile, tokenBalances: [...profile.tokenBalances, { tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount: configuredRichToken?.amount ?? option.amount }] }
			: { ...profile, tokenBalances: profile.tokenBalances.filter((balance) => !sameRichTokenIdentity(balance, option)) })
		if (enabled) recentRichTokenKeys.value = [tokenKey, ...recentRichTokenKeys.value.filter((key) => key !== tokenKey)].slice(0, 5)
		richTokenSaveConfirmedAddress.value = address
		return true
	}

	const addSelectedRichTokens = async () => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined || richTokenPending.value) return
		const options = availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenKey(option)))
		if (options.length === 0) return
		showRichTokenPicker.value = false
		addingRichTokenKeys.value = options.map(getRichTokenKey)
		failedAddedRichTokenKey.value = undefined
		const addedKeys: string[] = []
		for (const option of options) {
			const tokenKey = getRichTokenKey(option)
			if (!await setRichTokenEnabled(option, true, address)) {
				failedAddedRichTokenKey.value = tokenKey
				break
			}
			addedKeys.push(tokenKey)
			addingRichTokenKeys.value = addingRichTokenKeys.value.filter((key) => key !== tokenKey)
		}
		addingRichTokenKeys.value = []
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.filter((key) => !addedKeys.includes(key))
		if (addedKeys.length !== options.length) return
		newlyAddedRichTokenKeys.value = addedKeys
	}

	const saveNativeAmount = async (amount: bigint) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		const profile = selectedRichProfile.value
		if (address === undefined || profile === undefined || richTokenPending.value) return
		const previousAmount = profile.nativeAmount
		richTokenPending.value = true
		richTokenPendingKey.value = 'native'
		richTokenSaveConfirmedAddress.value = undefined
		richTokenPendingLabel.value = `Saving ${ nativeCurrencyTicker } amount…`
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: amount }))
		const reply = await sendPopupMessageWithReply({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: amount, address } })
		richTokenPending.value = false
		richTokenPendingKey.value = undefined
		richTokenPendingLabel.value = undefined
		if (reply?.result.success === true) {
			richTokenSaveConfirmedAddress.value = address
			return
		}
		updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: previousAmount }))
		richTokenError.value = reply === undefined ? 'The background service did not confirm the native balance.' : reply.result.error
		richTokenErrorTarget.value = 'native'
	}

	const setNativeAmount = (input: HTMLInputElement) => {
		const profile = selectedRichProfile.value
		if (profile === undefined) return
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, 18n)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? `${ nativeCurrencyTicker } amount cannot exceed the maximum uint256 value.`
				: `Enter a positive ${ nativeCurrencyTicker } amount with at most 18 decimal places.`
			richTokenErrorTarget.value = 'native'
			input.value = formatUnits(profile.nativeAmount, 18)
			return
		}
		void saveNativeAmount(parsedAmount.amount)
	}

	const saveRichTokenAmount = async (option: RichTokenOption, amount: bigint) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined) return
		if (richTokenPending.value) return
		const tokenKey = getRichTokenKey(option)
		richTokenPending.value = true
		richTokenPendingKey.value = tokenKey
		richTokenSaveConfirmedAddress.value = undefined
		richTokenPendingLabel.value = `Saving ${ getRichTokenLabel(option) } amount…`
		const reply = await sendPopupMessageWithReply({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount } })
		richTokenPending.value = false
		richTokenPendingKey.value = undefined
		richTokenPendingLabel.value = undefined
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
			richTokenErrorTarget.value = tokenKey
			return
		}
		updateProfileForAddress(address, (profile) => ({ ...profile, tokenBalances: profile.tokenBalances.map((balance) => sameRichTokenIdentity(balance, option) ? { ...balance, amount } : balance) }))
		richTokenSaveConfirmedAddress.value = address
	}

	const setRichTokenAmount = async (option: RichTokenOption, input: HTMLInputElement) => {
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, option.decimals)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? 'Token amount cannot exceed the maximum uint256 value.'
				: `Enter a positive ${ option.symbol } amount with at most ${ option.decimals.toString() } decimal places.`
			richTokenErrorTarget.value = getRichTokenKey(option)
			input.value = formatUnits(option.amount, Number(option.decimals))
			return
		}
		await saveRichTokenAmount(option, parsedAmount.amount)
	}

	const activeAddressSetAsRichViaFixedAddressList = useComputed(() =>
		richList.value.filter((element) => element.makingRich).some((element) => element.addressBookEntry.address === activeAddress.value?.address)
	)
	const visibleRichList = useComputed(() => {
		const peekedActiveAddress = activeAddress.peek() // peek active address here to avoid double render (changing active address retriggers rich bit later)
		if (peekedActiveAddress === undefined) return richList.value
		if (richList.value.some((element) => element.addressBookEntry.address === peekedActiveAddress.address)) return richList.value
		return [...richList.value, { addressBookEntry: peekedActiveAddress, makingRich: false, type: 'CurrentActiveAddress' as const }]
	})
	const richAccounts = useComputed(() => {
		const fixed = visibleRichList.value.filter((element) => element.makingRich)
		const current = activeAddress.value
		if (!makeCurrentAddressRich.value || current === undefined || fixed.some((element) => element.addressBookEntry.address === current.address)) return fixed
		return [{ addressBookEntry: current, makingRich: true, type: 'CurrentActiveAddress' as const }, ...fixed]
	})
	const richAssetCount = useComputed(() => {
		if (richAccounts.value.length === 0) return 0
		const accountAddresses = new Set(richAccounts.value.map((account) => account.addressBookEntry.address))
		const tokenKeys = new Set(richAccountBalances.value
			.filter((profile) => profile.chainId === chainId && accountAddresses.has(profile.address))
			.flatMap((profile) => profile.tokenBalances.map((balance) => `${ balance.tokenAddress.toString() }:${ balance.tokenId?.toString() ?? 'erc20' }`)))
		return tokenKeys.size + 1
	})
	const filteredVisibleRichList = useComputed(() => {
		const query = richAccountSearch.value.trim().toLowerCase()
		if (query === '') return visibleRichList.value
		return visibleRichList.value.filter((element) => element.addressBookEntry.name.toLowerCase().includes(query) || addressString(element.addressBookEntry.address).toLowerCase().includes(query))
	})
	const filteredCurrentRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address === activeAddress.value?.address))
	const filteredOtherRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address !== activeAddress.value?.address))
	const selectedRichAccount = useComputed(() => richAccounts.value.find((element) => element.addressBookEntry.address === selectedRichAddress.value))
	useSignalEffect(() => {
		const selectedAddress = selectedRichAddress.value
		if (selectedAddress === undefined || richAccounts.value.some((account) => account.addressBookEntry.address === selectedAddress)) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		resetRichDialogViewState()
		selectedRichAddress.value = undefined
	})
	const selectedRichProfile = useComputed(() => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		return richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === address)
	})
	const enabledRichTokens = useComputed(() => {
		const balances = selectedRichProfile.value?.tokenBalances ?? []
		return balances.flatMap((balance) => {
			const option = richTokenOptions.value.find((candidate) => sameRichTokenIdentity(candidate, balance))
			return option === undefined ? [] : [{ ...option, amount: balance.amount, enabled: true }]
		})
	})
	const availableRichTokens = useComputed(() => {
		const balances = selectedRichProfile.value?.tokenBalances ?? []
		return richTokenOptions.value.filter((option) => !balances.some((balance) => sameRichTokenIdentity(balance, option)))
	})
	const addingRichTokens = useComputed(() => availableRichTokens.value.filter((option) => addingRichTokenKeys.value.includes(getRichTokenKey(option))))
	const failedAddedRichToken = useComputed(() => availableRichTokens.value.find((option) => getRichTokenKey(option) === failedAddedRichTokenKey.value))
	const richBalanceTokenCountLabel = useComputed(() => {
		if (addingRichTokens.value.length !== 0) return `${ addingRichTokens.value.length.toString() } adding`
		if (failedAddedRichToken.value !== undefined) return 'Needs attention'
		return `${ enabledRichTokens.value.length.toString() } token${ enabledRichTokens.value.length === 1 ? '' : 's' }`
	})
	const richOperationStatus = useComputed(() => {
		if (richTokenPending.value) return { className: 'is-saving', label: addingRichTokenKeys.value.length === 0 ? 'Saving…' : 'Scanning…' }
		if (richTokenError.value !== undefined) return { className: 'is-error', label: 'Needs attention' }
		if (richTokenSaveConfirmedAddress.value === selectedRichAddress.value) return { className: 'is-saved', label: '✓ Saved' }
		return undefined
	})
	const matchingAvailableRichTokens = useComputed(() => {
		const filteredByType = availableRichTokens.value.filter((option) => {
			switch (richTokenFilter.value) {
				case 'All': return true
				case 'ERC20': return option.tokenType === 'ERC20'
				case 'ERC1155': return option.tokenType === 'ERC1155'
				case 'Ready': return option.balanceSlot !== undefined
				case 'NeedsScan': return option.balanceSlot === undefined
				default: return assertNever(richTokenFilter.value)
			}
		})
		const candidates = richTokenSearch.value.trim() === ''
			? [...filteredByType].sort((first, second) => {
				const firstSelected = selectedRichTokenKeys.value.includes(getRichTokenKey(first))
				const secondSelected = selectedRichTokenKeys.value.includes(getRichTokenKey(second))
				if (firstSelected !== secondSelected) return firstSelected ? -1 : 1
				const firstIndex = recentRichTokenKeys.value.indexOf(getRichTokenKey(first))
				const secondIndex = recentRichTokenKeys.value.indexOf(getRichTokenKey(second))
				if (firstIndex === -1 && secondIndex === -1) return 0
				if (firstIndex === -1) return 1
				if (secondIndex === -1) return -1
				return firstIndex - secondIndex
			})
			: filteredByType
		return getMatchingRichTokenOptions(candidates, richTokenSearch.value)
	})
	const activeRichTokenIndex = useComputed(() => Math.min(highlightedRichTokenIndex.value, Math.max(0, matchingAvailableRichTokens.value.length - 1)))
	const selectedAvailableRichTokens = useComputed(() => availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenKey(option))))
	const selectedRichAccountIndex = useComputed(() => richAccounts.value.findIndex((account) => account.addressBookEntry.address === selectedRichAddress.value))
	const showAdjacentRichAccount = (offset: -1 | 1) => {
		if (richTokenPending.value || richAccounts.value.length < 2) return
		const currentIndex = selectedRichAccountIndex.value
		if (currentIndex === -1) return
		const nextIndex = (currentIndex + offset + richAccounts.value.length) % richAccounts.value.length
		const nextAccount = richAccounts.value[nextIndex]
		if (nextAccount === undefined) return
		selectedRichAddress.value = nextAccount.addressBookEntry.address
		showRichTokenPicker.value = false
		resetRichDialogViewState()
	}
	const closeRichBalanceDialog = () => {
		if (richTokenPending.value) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		resetRichDialogViewState()
	}
	const showRichTokenSelection = () => {
		showRichTokenPicker.value = true
	}
	const hideRichTokenSelection = () => {
		if (richTokenPending.value) return
		showRichTokenPicker.value = false
		globalThis.queueMicrotask(() => { selectRichTokensButtonRef.current?.focus() })
	}
	const retryFailedRichTokenSelection = () => {
		if (failedAddedRichTokenKey.value === undefined || richTokenPending.value) return
		failedAddedRichTokenKey.value = undefined
		void addSelectedRichTokens()
	}
	const removeFailedRichTokenSelection = () => {
		const failedKey = failedAddedRichTokenKey.value
		if (failedKey === undefined || richTokenPending.value) return
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.filter((key) => key !== failedKey)
		failedAddedRichTokenKey.value = undefined
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
	}
	const toggleRichTokenSelection = (option: RichTokenOption) => {
		const key = getRichTokenKey(option)
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.includes(key)
			? selectedRichTokenKeys.value.filter((selectedKey) => selectedKey !== key)
			: [...selectedRichTokenKeys.value, key]
	}
	const handleRichTokenSearchKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
		const options = matchingAvailableRichTokens.value
		if (options.length === 0) return
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			highlightedRichTokenIndex.value = (highlightedRichTokenIndex.value + 1) % options.length
			return
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			highlightedRichTokenIndex.value = (highlightedRichTokenIndex.value - 1 + options.length) % options.length
			return
		}
		if (event.key !== 'Enter') return
		event.preventDefault()
		const option = options[activeRichTokenIndex.value]
		if (option !== undefined) toggleRichTokenSelection(option)
	}
	const renderRichAccountRow = (richListElement: EnrichedRichListElement) => {
		const accountIsRich = richAccounts.value.some((account) => account.addressBookEntry.address === richListElement.addressBookEntry.address)
		const accountProfile = richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === richListElement.addressBookEntry.address)
		const isCurrentAddressRow = richListElement.type === 'CurrentActiveAddress'
		const isActiveAddressRow = richListElement.addressBookEntry.address === activeAddress.value?.address
		const configuredAssetCount = accountProfile === undefined ? 0 : accountProfile.tokenBalances.length + 1
		const accountAddress = addressString(richListElement.addressBookEntry.address)
		const accountAddressDescriptionId = `rich-account-address-${ accountAddress.slice(2) }`
		const openBalances = () => {
			selectedRichAddress.value = richListElement.addressBookEntry.address
			showRichBalanceDialog.value = true
		}
		return <div class = { `rich-mode-account-row${ accountIsRich ? ' is-rich' : '' }${ isActiveAddressRow ? ' is-active-account' : '' }` } key = { richListElement.addressBookEntry.address.toString() }>
			<input class = 'rich-mode-account-toggle' type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { isCurrentAddressRow ? makeCurrentAddressRich.value : richListElement.makingRich } aria-label = { `Toggle rich mode for ${ richListElement.addressBookEntry.name } (${ accountAddress })` } onInput = { event => { if (event.target instanceof HTMLInputElement && event.target !== null) { isCurrentAddressRow ? enableMakeCurrentAddressRich(event.target.checked) : modifyRichList(richListElement.addressBookEntry, event.target.checked) } } } />
			<button type = 'button' class = 'rich-mode-account-open' disabled = { !accountIsRich } aria-label = { `Edit balances for ${ richListElement.addressBookEntry.name }` } aria-describedby = { accountAddressDescriptionId } data-configured-assets = { configuredAssetCount.toString() } onClick = { openBalances }>
				<AddressIcon address = { richListElement.addressBookEntry.address } logoUri = { 'logoUri' in richListElement.addressBookEntry ? richListElement.addressBookEntry.logoUri : undefined } isBig = { false } backgroundColor = 'var(--surface-dark-color)'/>
				<span class = 'rich-mode-account-details'>
					<span class = 'rich-mode-account-name-line'><strong>{ richListElement.addressBookEntry.name }</strong>{ isActiveAddressRow ? <span class = 'rich-mode-current-account-badge'>Current</span> : <></> }</span>
					<span class = 'rich-mode-account-secondary'>
						{ !accountIsRich ? <small>Enable to configure balances</small> : <RichBalanceSummary profile = { accountProfile } tokenOptions = { richTokenOptions.value } nativeCurrencyTicker = { nativeCurrencyTicker }/> }
						<small class = 'rich-mode-account-address' id = { accountAddressDescriptionId } aria-label = { accountAddress } title = { accountAddress }>{ truncateAddr(accountAddress, 4) }</small>
					</span>
				</span>
				<span class = 'rich-mode-balance-action' aria-hidden = 'true'>›</span>
			</button>
		</div>
	}

	return <>
		<header class = 'card-header rich-mode-card-header'>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em; padding: 0 0.5rem;'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content;' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { makeCurrentAddressRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeCurrentAddressRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Make current account rich</p>
				</label>
			</p>
			<button type = 'button' class = 'card-header-icon noselect rich-mode-card-header-summary' aria-controls = 'rich-mode-account-manager' aria-expanded = { showList.value } aria-label = { showList.value ? 'Hide rich accounts' : 'Show rich accounts' } onClick = { () => { showList.value = !showList.value } }>
				<span>{ richAccounts.value.length.toString() } account{ richAccounts.value.length === 1 ? '' : 's' } · { richAssetCount.value.toString() } asset{ richAssetCount.value === 1 ? '' : 's' }</span>
				<span class = 'icon'><ChevronIcon /></span>
			</button>
		</header>
		{ !showList.value
			? <> { !activeAddressSetAsRichViaFixedAddressList.value || activeAddress.value === undefined ? <></> : <>
				<div class = 'card-content-header' style = 'font-size: 0.8em;'>
					<label class = 'form-control' style = 'gap: 1em;'>
						<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { true } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null && activeAddress.value !== undefined) { modifyRichList(activeAddress.value, e.target.checked) } } } />
						<SmallAddress addressBookEntry = { activeAddress } renameAddressCallBack = { renameAddressCallBack } noCopying = { !isInitialHomeDataLoaded.value } noEditAddress = { !isInitialHomeDataLoaded.value } />
					</label>
				</div>
			</> } </>
			: <div id = 'rich-mode-account-manager' class = 'card-content rich-mode-account-manager'>
				<div class = 'rich-mode-account-list-head'>
					<div><strong>Accounts</strong><small>{ richAccounts.value.length.toString() } enabled · { richAssetCount.value.toString() } asset{ richAssetCount.value === 1 ? '' : 's' }</small></div>
					{ visibleRichList.value.length <= 6 ? <></> : <label class = 'rich-mode-account-search'>
						<span aria-hidden = 'true'><SearchIcon/></span>
						<input type = 'search' aria-label = 'Search rich accounts' placeholder = 'Search accounts…' value = { richAccountSearch.value } onInput = { event => { richAccountSearch.value = event.currentTarget.value } } />
					</label> }
				</div>
				<div>
					<div aria-label = 'Rich accounts' class = 'rich-mode-account-list'>
						{ filteredCurrentRichList.value.length === 0 ? <></> : <section class = 'rich-mode-account-group' aria-label = 'Current account'><p class = 'rich-mode-account-group-label'>Current account</p>{ filteredCurrentRichList.value.map(renderRichAccountRow) }</section> }
						{ filteredOtherRichList.value.length === 0 ? <></> : <section class = 'rich-mode-account-group' aria-label = 'Other rich accounts'><p class = 'rich-mode-account-group-label'>Other accounts</p>{ filteredOtherRichList.value.map(renderRichAccountRow) }</section> }
						{ filteredVisibleRichList.value.length !== 0 ? <></> : <div class = 'rich-mode-account-empty'><strong>No matching accounts</strong><button type = 'button' class = 'btn btn--ghost is-small' onClick = { () => { richAccountSearch.value = '' } }>Clear search</button></div> }
					</div>
				</div>
			</div>
		}
		{ !showRichBalanceDialog.value || selectedRichAccount.value === undefined
			? <></>
			: <div
				class = 'modal is-active rich-mode-modal-layer'
				onKeyDown = { event => {
					if (event.key !== 'Escape' || richTokenPending.value) return
					showRichTokenPicker.value ? hideRichTokenSelection() : closeRichBalanceDialog()
				} }
			>
				<InterceptorDialogSurface ariaLabel = { showRichTokenPicker.value ? `Select tokens for ${ selectedRichAccount.value.addressBookEntry.name }` : `Balance editor for ${ selectedRichAccount.value.addressBookEntry.name }` } class = { `rich-mode-modal-card${ showRichTokenPicker.value ? ' is-selecting-tokens' : '' }` } onBackdropClick = { closeRichBalanceDialog } size = 'large'>
					<InterceptorDialogHeader
						accessory = { <div class = 'rich-mode-header-tools'>
							{ richOperationStatus.value === undefined ? <></> : <span class = { `rich-mode-save-status ${ richOperationStatus.value.className }` } role = 'status'>{ richOperationStatus.value.label }</span> }
							{ showRichTokenPicker.value || richAccounts.value.length < 2 ? <></> : <div class = 'rich-mode-header-account-switcher' aria-label = 'Rich account navigation'>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Previous rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(-1) } }>‹</button>
								<span>{ (selectedRichAccountIndex.value + 1).toString() } / { richAccounts.value.length.toString() }</span>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Next rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(1) } }>›</button>
							</div> }
						</div> }
						close = { closeRichBalanceDialog }
						closeDisabled = { richTokenPending.value }
						closeLabel = 'Close balance manager'
						icon = '../img/address-book.svg'
						iconContent = { <AddressIcon address = { selectedRichAccount.value.addressBookEntry.address } logoUri = { 'logoUri' in selectedRichAccount.value.addressBookEntry ? selectedRichAccount.value.addressBookEntry.logoUri : undefined } isBig = { false } backgroundColor = 'var(--surface-dark-color)'/> }
						title = 'Balances'
						subtitle = { selectedRichAccount.value.addressBookEntry.name }
					/>
					<InterceptorDialogBody class = { `rich-mode-dialog-body${ showRichTokenPicker.value ? ' is-token-view' : '' }` }>
						{ !showRichTokenPicker.value ? <div class = 'card rich-mode-modal-content'>
							<div class = 'card-content rich-mode-balance-page'>
								<div class = 'rich-mode-modal-toolbar'>
									<div class = 'rich-mode-modal-title-group'><p class = 'paragraph checkbox-text rich-mode-modal-section-title'>Amounts</p><span class = 'rich-mode-count-badge'>{ richBalanceTokenCountLabel.value }</span></div>
									<div class = 'actions'>
										<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Open token address book' data-tooltip = 'Open token address book' onClick = { () => { void sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' }) } }>
											<span class = 'icon'><img src = '../img/address-book.svg' width = '18' height = '18'/></span>
										</button>
									<button type = 'button' class = 'btn btn--outline is-small' aria-label = 'Select tokens' ref = { selectRichTokensButtonRef } disabled = { richTokenPending.value || selectedRichProfile.value === undefined || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select tokens</button>
									</div>
								</div>
								{ selectedRichProfile.value === undefined ? <p class = 'help'>This account has no balance profile.</p> : <>
									<div class = 'rich-mode-balance-row rich-mode-balance-row--native'>
										<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { nativeCurrencyTicker } logoUri = { nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }/>
										<span class = 'rich-mode-balance-token-name'><strong>{ nativeCurrencyTicker }</strong><small>Native currency</small></span>
										<RichAmountEditor amount = { selectedRichProfile.value.nativeAmount } defaultAmount = { richNativeAmount.value } decimals = { 18 } disabled = { richTokenPending.value } error = { richTokenErrorTarget.value === 'native' ? richTokenError.value : undefined } label = { `${ nativeCurrencyTicker } rich amount for ${ selectedRichAccount.value.addressBookEntry.name }` } unit = { nativeCurrencyTicker } onCommit = { setNativeAmount } onReset = { () => { richTokenError.value = undefined; richTokenErrorTarget.value = undefined; void saveNativeAmount(richNativeAmount.value) } }/>
										<span/>
									</div>
									<div aria-busy = { richTokenPending.value } aria-label = 'Configured rich tokens' class = 'rich-mode-configured-tokens'>
										{ enabledRichTokens.value.length !== 0 || addingRichTokens.value.length !== 0 || failedAddedRichToken.value !== undefined ? <></> : <div class = 'rich-mode-empty-state'>
											<span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>+</span>
											<span><strong>Only { nativeCurrencyTicker }</strong><small>Add an address-book token.</small></span>
											<button type = 'button' class = 'btn btn--ghost is-small' disabled = { richTokenPending.value || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select token</button>
										</div> }
										{ addingRichTokens.value.map((option) => <div class = 'rich-mode-balance-row is-adding' key = { `adding:${ getRichTokenKey(option) }` }>
											<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { option.symbol } logoUri = { option.logoUri }/>
											<span class = 'rich-mode-balance-token-name'><strong>{ getRichTokenLabel(option) }</strong><small>{ option.name }</small></span>
											<span class = 'rich-mode-balance-progress' role = 'status'>{ richTokenPendingKey.value === getRichTokenKey(option) ? 'Scanning storage…' : 'Queued' }</span>
											<span/>
										</div>) }
										{ failedAddedRichToken.value === undefined ? <></> : <div class = 'rich-mode-balance-row is-failed' key = { `failed:${ getRichTokenKey(failedAddedRichToken.value) }` }>
											<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { failedAddedRichToken.value.symbol } logoUri = { failedAddedRichToken.value.logoUri }/>
											<span class = 'rich-mode-balance-token-name'><strong>{ getRichTokenLabel(failedAddedRichToken.value) }</strong><small>{ richTokenError.value ?? 'Storage scan failed.' }</small></span>
											<button type = 'button' class = 'btn btn--outline is-small' disabled = { richTokenPending.value } onClick = { retryFailedRichTokenSelection }>Retry</button>
											<button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' disabled = { richTokenPending.value } aria-label = { `Remove failed rich token ${ getRichTokenLabel(failedAddedRichToken.value) }` } data-tooltip = 'Remove token' onClick = { removeFailedRichTokenSelection }><TrashIcon/></button>
										</div> }
										{ enabledRichTokens.value.map((option) => <div class = { `rich-mode-balance-row${ newlyAddedRichTokenKeys.value.includes(getRichTokenKey(option)) ? ' is-new' : '' }` } key = { getRichTokenKey(option) }>
											<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { option.symbol } logoUri = { option.logoUri }/>
											<span class = 'rich-mode-balance-token-name'><strong>{ getRichTokenLabel(option) }</strong><small>{ option.name }</small></span>
											<RichAmountEditor amount = { option.amount } autoFocus = { newlyAddedRichTokenKeys.value[0] === getRichTokenKey(option) } defaultAmount = { getDefaultRichTokenAmount(option.decimals) } decimals = { Number(option.decimals) } disabled = { !option.enabled || richTokenPending.value } error = { richTokenErrorTarget.value === getRichTokenKey(option) ? richTokenError.value : undefined } label = { `${ getRichTokenLabel(option) } rich amount` } unit = { option.symbol } onCommit = { input => { void setRichTokenAmount(option, input) } } onReset = { () => { richTokenError.value = undefined; richTokenErrorTarget.value = undefined; void saveRichTokenAmount(option, getDefaultRichTokenAmount(option.decimals)) } }/>
											<button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' disabled = { richTokenPending.value } aria-label = { `Remove rich token ${ getRichTokenLabel(option) }` } data-tooltip = 'Remove token' onClick = { () => { void setRichTokenEnabled(option, false) } }><TrashIcon/></button>
										</div>) }
									</div>
								</> }
							{ richTokenPendingLabel.value === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenPendingLabel.value }</p> }
							{ richTokenError.value === undefined || richTokenErrorTarget.value !== undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
							</div>
						</div> : <section class = 'rich-mode-token-view' role = 'region' aria-label = { `Select tokens for ${ selectedRichAccount.value.addressBookEntry.name }` }>
						<header class = 'rich-mode-token-view-navigation'>
							<button type = 'button' class = 'btn btn--ghost rich-mode-modal-back' aria-label = 'Back to balances' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>‹</button>
							<div class = 'rich-mode-token-view-heading'>
								<nav aria-label = 'Rich balance navigation'><span>Balances</span><span aria-hidden = 'true'>/</span><strong>Select tokens</strong></nav>
								<span class = 'rich-mode-count-badge'>{ availableRichTokens.value.length.toString() } available</span>
							</div>
						</header>
						<div class = 'rich-mode-token-view-content'>
							<div class = 'field rich-mode-token-search'>
								<div class = 'control'>
									<input
										class = 'input'
										type = 'search'
										autoFocus = { true }
										aria-activedescendant = { matchingAvailableRichTokens.value.length === 0 ? undefined : `rich-token-option-${ activeRichTokenIndex.value.toString() }` }
										aria-autocomplete = 'list'
										aria-controls = 'rich-token-search-results'
										aria-expanded = 'true'
										aria-label = 'Search address-book tokens'
										placeholder = { `Search ${ availableRichTokens.value.length.toString() } address-book token${ availableRichTokens.value.length === 1 ? '' : 's' }…` }
										disabled = { richTokenPending.value }
										role = 'combobox'
										value = { richTokenSearch.value }
										onInput = { event => { richTokenSearch.value = event.currentTarget.value; highlightedRichTokenIndex.value = 0 } }
										onKeyDown = { handleRichTokenSearchKeyDown }
									/>
								</div>
							</div>
							<div class = 'rich-mode-token-filters' aria-label = 'Filter address-book tokens' role = 'group'>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'All' } onClick = { () => { richTokenFilter.value = 'All'; highlightedRichTokenIndex.value = 0 } }>All</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC20' } onClick = { () => { richTokenFilter.value = 'ERC20'; highlightedRichTokenIndex.value = 0 } }>ERC20</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC1155' } onClick = { () => { richTokenFilter.value = 'ERC1155'; highlightedRichTokenIndex.value = 0 } }>ERC1155</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'Ready' } onClick = { () => { richTokenFilter.value = 'Ready'; highlightedRichTokenIndex.value = 0 } }>Ready</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'NeedsScan' } onClick = { () => { richTokenFilter.value = 'NeedsScan'; highlightedRichTokenIndex.value = 0 } }>Needs scan</button>
							</div>
							{ selectedAvailableRichTokens.value.length === 0 ? <></> : <div class = 'rich-mode-selected-token-bar'><div class = 'rich-mode-selected-token-chips' aria-label = 'Selected tokens'>
								{ selectedAvailableRichTokens.value.map((option) => <button type = 'button' class = { `rich-mode-selected-token-chip${ richTokenPendingKey.value === getRichTokenKey(option) ? ' is-pending' : '' }` } aria-label = { `Remove ${ getRichTokenLabel(option) } from selection` } disabled = { richTokenPending.value } onClick = { () => { toggleRichTokenSelection(option) } } key = { getRichTokenKey(option) }>
									<RichTokenIcon class = 'rich-mode-selected-token-chip-icon' label = { option.symbol } logoUri = { option.logoUri }/>
									<span>{ getRichTokenLabel(option) }</span><span aria-hidden = 'true'>{ richTokenPendingKey.value === getRichTokenKey(option) ? '…' : '×' }</span>
								</button>) }
							</div><button type = 'button' class = 'btn btn--ghost is-small rich-mode-clear-token-selection' disabled = { richTokenPending.value } onClick = { () => { selectedRichTokenKeys.value = [] } }>Clear</button>
							</div> }
							<div
								id = 'rich-token-search-results'
								aria-label = 'Matching address-book tokens'
								aria-multiselectable = 'true'
								class = 'rich-mode-token-results'
								role = 'listbox'
								ref = { element => { if (element !== null) element.scrollTop = richTokenResultsScrollTop.peek() } }
								onScroll = { event => { richTokenResultsScrollTop.value = event.currentTarget.scrollTop } }
							>
								{ matchingAvailableRichTokens.value.map((option, index) => {
									const selected = selectedRichTokenKeys.value.includes(getRichTokenKey(option))
									const pending = richTokenPendingKey.value === getRichTokenKey(option)
									const recent = recentRichTokenKeys.value.includes(getRichTokenKey(option))
									return <button
										type = 'button'
										id = { `rich-token-option-${ index.toString() }` }
										data-rich-token-result = { getRichTokenKey(option) }
										class = { `btn btn--ghost rich-mode-token-result${ selected ? ' is-selected' : '' }${ activeRichTokenIndex.value === index ? ' is-highlighted' : '' }${ pending ? ' is-pending' : '' }` }
										disabled = { richTokenPending.value }
										aria-label = { `Select rich token ${ getRichTokenLabel(option) } ${ addressString(option.tokenAddress) }` }
										aria-selected = { selected }
										role = 'option'
										onClick = { () => { toggleRichTokenSelection(option) } }
										onMouseEnter = { () => { highlightedRichTokenIndex.value = index } }
										key = { getRichTokenKey(option) }
									>
										<RichTokenIcon class = 'rich-mode-token-result-icon' label = { option.symbol } logoUri = { option.logoUri }/>
										<span class = 'rich-mode-token-result-details'>
											<strong><HighlightedRichTokenText query = { richTokenSearch.value } text = { getRichTokenLabel(option) }/></strong>
											<span class = 'rich-mode-token-result-meta'><span><HighlightedRichTokenText query = { richTokenSearch.value } text = { option.name }/></span><em>{ recent && richTokenSearch.value.trim() === '' ? `Recent · ${ option.tokenType }` : option.tokenType }</em></span>
											<small><HighlightedRichTokenText query = { richTokenSearch.value } text = { addressString(option.tokenAddress) }/></small>
										</span>
										<span class = { `rich-mode-token-layout-status${ pending ? ' is-pending' : option.balanceSlot === undefined ? '' : ' is-ready' }` } aria-label = { pending ? `Preparing ${ getRichTokenLabel(option) }` : option.balanceSlot === undefined ? 'Storage scan required' : 'Storage layout ready' }>{ pending ? 'Scanning…' : option.balanceSlot === undefined ? 'Scan' : 'Ready' }</span>
										<span class = 'rich-mode-token-selection-mark' aria-hidden = 'true'>{ selected ? '✓' : '' }</span>
									</button>
								}) }
								{ matchingAvailableRichTokens.value.length === 0 ? <div class = 'rich-mode-empty-state rich-mode-token-empty-state'><span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>⌕</span><span><strong>No matching tokens</strong><small>Try a symbol, name, or address.</small></span>{ richTokenSearch.value === '' ? <></> : <button type = 'button' class = 'btn btn--ghost is-small' onClick = { () => { richTokenSearch.value = '' } }>Clear</button> }</div> : <></> }
							</div>
							{ richTokenError.value === undefined || failedAddedRichToken.value === undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
						</div>
					</section> }
					</InterceptorDialogBody>
					{ !showRichTokenPicker.value ? <></> : <InterceptorDialogFooter class = 'rich-mode-token-view-footer'>
						<button type = 'button' class = 'btn btn--ghost' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>Back</button>
						<span class = 'rich-mode-token-selection-count rich-mode-count-badge'>{ selectedAvailableRichTokens.value.length.toString() } selected</span>
						<button type = 'button' class = 'btn btn--primary' aria-label = 'Add selected tokens' disabled = { richTokenPending.value || selectedAvailableRichTokens.value.length === 0 } onClick = { () => { void addSelectedRichTokens() } }>Add { selectedAvailableRichTokens.value.length === 0 ? '' : selectedAvailableRichTokens.value.length.toString() } token{ selectedAvailableRichTokens.value.length === 1 ? '' : 's' }</button>
					</InterceptorDialogFooter> }
				</InterceptorDialogSurface>
			</div>
		}
	</>
}

function FirstCard(param: FirstCardParams) {
	const timeSelectorMode = useSignal<TimePickerMode>('For')
	const timeSelectorAbsoluteTime = useSignal<Date | undefined>(undefined)
	const timeSelectorDeltaValue = useSignal<bigint>(12n)
	const timeSelectorDeltaUnit = useSignal<DeltaUnit>('Seconds')
	const { value: connectToSignerButtonState, waitFor: waitForConnectToSigner } = useAsyncState<void>()
	const signerAvailable = useComputed(() => isSignerAvailable(param.tabState.value))
	const isActiveAddressLoading = !param.isFreshHomeDataLoaded.value && param.activeAddress.value === undefined

	const connectToSigner = () => {
		if (!param.isInitialHomeDataLoaded.value) return
		void waitForConnectToSigner(() => sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true }))
	}

	const timeSelectorOnChange = () => {
		if (!param.isInitialHomeDataLoaded.value) return
		const blockTimeManipulation = getTimeManipulatorFromSignals(timeSelectorMode.value, timeSelectorAbsoluteTime.value, timeSelectorDeltaValue.value, timeSelectorDeltaUnit.value)
		if (blockTimeManipulation.type === 'No Delay') return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION } })
		return sendPopupMessageToBackgroundPage({ method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation } })
	}

	useSignalEffect(() => {
		const value = param.preSimulationBlockTimeManipulation.value
		switch(value?.type) {
			case 'AddToTimestamp': {
				timeSelectorMode.value = 'For'
				timeSelectorDeltaValue.value = value.deltaToAdd
				timeSelectorDeltaUnit.value = value.deltaUnit
				break
			}
			case 'SetTimetamp': {
				timeSelectorMode.value = 'Until'
				timeSelectorAbsoluteTime.value = bigintSecondsToDate(value.timeToSet)
				break
			}
			case undefined: break
			default: assertNever(value)
		}
	})

	if (param.tabState.value?.signerName === 'NoSigner' && param.simulationMode.value === false) {
		return <>
			<section class = 'card popup-home-card popup-data-reveal'>
				<FirstCardHeader { ...param }/>
				<div class = 'card-content'>
					<DinoSays text = { 'No signer connnected. You can use Interceptor in simulation mode without a signer, but signing mode requires a browser wallet.' } />
				</div>
			</section>
		</>
	}

	return <>
		<section class = 'card popup-home-card popup-data-reveal'>
			<FirstCardHeader { ...param }/>
			<div class = 'card-content'>
				{ param.useSignersAddressAsActiveAddress.value || !param.simulationMode.value ?
					<p style = 'color: var(--text-color); text-align: left; padding-bottom: 10px'>
						{ param.tabState.value === undefined || param.tabState.value?.signerName === 'NoSigner' ? <></> : <>Retrieving from&nbsp;<SignersLogoName signerName = { param.tabState.value.signerName } /></> }
						{ isActiveAddressLoading
							? <InlineLoadingSkeleton ariaLabel = 'Loading signer connection state'/>
							: signerAvailable.value
								? <span class = 'popup-home-connection-status popup-data-reveal-inline' style = 'color: var(--primary-color);'>CONNECTED</span>
								: <span class = 'popup-home-connection-status popup-data-reveal-inline' style = 'color: var(--negative-color);'>NOT CONNECTED</span>
						}
					</p>
					: <></>
				}

				{ isActiveAddressLoading
					? <ActiveAddressLoadingSkeleton ariaLabel = 'Loading active address'/>
					: <div class = 'popup-data-reveal'>
						<ActiveAddressComponent
							activeAddress = { param.activeAddress }
							buttonText = { 'Change' }
							disableButton = { !param.simulationMode.value || !param.isInitialHomeDataLoaded.value }
							noCopying = { !param.isInitialHomeDataLoaded.value }
							noEditAddress = { !param.isInitialHomeDataLoaded.value }
							changeActiveAddress = { param.changeActiveAddress }
							renameAddressCallBack = { param.renameAddressCallBack }
						/>
					</div>
				}
				{ isActiveAddressLoading ? <></> : !param.simulationMode.value ? <>
					{ (param.tabState.value?.signerAccounts.length === 0 && param.tabIconDetails.value.icon !== ICON_NOT_ACTIVE && param.tabIconDetails.value.icon !== ICON_NOT_ACTIVE_WITH_SHIELD) ?
						<div style = 'margin-top: 5px'>
							<AsyncActionButton
								class = 'button is-primary'
								disabled = { !param.isInitialHomeDataLoaded.value }
								state = { connectToSignerButtonState.value.state }
								text = { <SignerLogoText
									signerName = { param.tabState.value?.signerName ?? 'NoSignerDetected' }
									text = { `Connect to ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` }
								/> }
								pendingText = { `Connecting to ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` }
								onClick = { connectToSigner }
							/>
						</div>
						: <p style = 'color: var(--subtitle-text-color);' class = 'subtitle is-7'> { ` You can change active address by changing it directly from ${ getPrettySignerName(param.tabState.value?.signerName ?? 'NoSignerDetected') }` } </p>
					}
				</> : !param.isFreshHomeDataLoaded.value ?
					<SimulationControlsLoadingSkeleton/>
				: <div class = 'popup-simulation-controls popup-data-reveal'>
					<RichList activeAddress = { param.activeAddress } makeCurrentAddressRich = { param.makeCurrentAddressRich } richNativeAmount = { param.richNativeAmount } nativeCurrencyTicker = { param.rpcNetwork.value?.currencyTicker ?? 'ETH' } chainId = { param.rpcNetwork.value?.chainId ?? 1n } renameAddressCallBack = { param.renameAddressCallBack } richList = { param.richList } richTokenOptions = { param.richTokenOptions } richAccountBalances = { param.richAccountBalances } isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }/>
					<div class = 'popup-simulation-controls-gap'/>
					<TimePicker
						startText = 'Delay first transaction'
						mode = { timeSelectorMode }
						absoluteTime = { timeSelectorAbsoluteTime }
						deltaValue = { timeSelectorDeltaValue }
						deltaUnit = { timeSelectorDeltaUnit }
						onChangedCallBack = { timeSelectorOnChange }
						removeNoDelayOption = { true }
						disabled = { !param.isInitialHomeDataLoaded.value }
					/>
				</div> }
			</div>
		</section>

		{ isActiveAddressLoading ? <></> : <SignerExplanation activeAddress = { param.activeAddress } tabState = { param.tabState }/> }
	</>
}

const isEmptySimulation = (simulationAndVisualisationResults: SimulationAndVisualisationResults) => {
	const simulationStateInput = simulationAndVisualisationResults.simulationStateInput
	if (simulationStateInput === undefined) return isEmptySimulationAndVisualisationResults(simulationAndVisualisationResults)
	return !simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
}

type SimulationResultsHeaderParams = {
	openSimulationStack?: () => void
	disableReset?: ReadonlySignal<boolean>
	resetSimulation?: () => Promise<void>
}

function SimulationResultsHeader(param: SimulationResultsHeaderParams) {
	const { value: clearSimulationState, waitFor: waitForClearSimulation } = useAsyncState<void>()
	const openStack = () => { param.openSimulationStack?.() }
	const resetSimulation = param.resetSimulation
	const clearSimulation = () => {
		if (resetSimulation === undefined) return
		void waitForClearSimulation(resetSimulation)
	}

	return <div class = 'simulation-results-header'>
		<div class = 'log-cell' style = 'justify-content: left; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;'>
			<p class = 'h1' style = 'margin: 0;'> Simulation Results </p>
		</div>
		<div class = 'log-cell' style = 'justify-content: right; align-items: center; gap: 6px; flex-wrap: wrap; max-width: 300px;'>
			{ param.openSimulationStack === undefined ? <></> :
				<button class = 'btn btn--outline is-small' onClick = { openStack } title = 'Open simulation stack details in a new tab' aria-label = 'Open simulation stack details in a new tab'>
					<OpenSimulationStackButtonContent/>
				</button>
			}
			{ param.disableReset === undefined || param.resetSimulation === undefined ? <></> :
				<AsyncActionButton
					class = 'btn is-small is-danger'
					state = { clearSimulationState.value.state }
					disabled = { param.disableReset.value }
					onClick = { clearSimulation }
					text = { <ClearSimulationButtonContent/> }
					pendingText = 'Clearing...'
				/>
			}
		</div>
	</div>
}

function RichAddressesTitleCard({ numberOfAddressesMadeRich, openSimulationStack }: { numberOfAddressesMadeRich: number, openSimulationStack?: () => void }) {
	if (numberOfAddressesMadeRich === 0) return <></>
	const actionLabel = 'Open rich address state in the full simulation stack'
	const openStack = () => { openSimulationStack?.() }
	return <section class = 'card' style = 'margin: 10px;'>
		<header
			class = { `card-header stack-card-header${ openSimulationStack === undefined ? '' : ' stack-row-link-header' }` }
			onClick = { openStack }
			onKeyDown = { (event) => {
				if (openSimulationStack === undefined || (event.key !== 'Enter' && event.key !== ' ')) return
				if (event.target !== event.currentTarget) return
				event.preventDefault()
				openStack()
			} }
			role = { openSimulationStack === undefined ? undefined : 'button' }
			tabIndex = { openSimulationStack === undefined ? undefined : 0 }
			title = { openSimulationStack === undefined ? undefined : actionLabel }
			aria-label = { openSimulationStack === undefined ? undefined : actionLabel }
		>
			<div class = 'card-header-icon unset-cursor'>
				<span class = 'icon'>
					<img src = '../img/success-icon.svg' width = '24' height = '24' />
				</span>
			</div>
			<p class = 'card-header-title' style = 'white-space: nowrap;'>
				Simply making { numberOfAddressesMadeRich } { numberOfAddressesMadeRich === 1 ? 'address' : 'addresses' } rich
			</p>
		</header>
	</section>
}

function PopupVisualisation(param: SimulationStateParam) {
	const isEmpty = useComputed(() => {
		if (param.numberOfAddressesMadeRich.value > 0) return false
		if (param.simulationAndVisualisationResults.value.kind === 'passthrough') return true
		return isEmptySimulation(param.simulationAndVisualisationResults.value.value)
	})

	const computedAddressBookEntries = useComputed(() => param.simulationAndVisualisationResults.value.kind === 'simulated' ? param.simulationAndVisualisationResults.value.value.addressBookEntries : [])
	const currentResults = param.simulationAndVisualisationResults.value
	const isSimulationStatusUnknown = param.simulationUpdatingState.value === undefined || param.simulationResultState.value === undefined

	if (isSimulationStatusUnknown || (isEmpty.value && param.simulationUpdatingState.value === 'updating')) {
		return <SimulationLoadingSkeleton/>
	}

	if (currentResults.kind === 'passthrough') {
		return <div class = 'popup-data-reveal'>
			<SimulationResultsHeader openSimulationStack = { param.openSimulationStack } />
			{ isEmpty.value ?
				<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
			: <RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } /> }
		</div>
	}

	const resolvedResults = currentResults.value

	return <div class = 'popup-data-reveal'>
		<SimulationResultsHeader openSimulationStack = { param.openSimulationStack } disableReset = { param.disableReset } resetSimulation = { param.resetSimulation } />

			{ resolvedResults.visualizedSimulationState.success === false ? <>
				<ErrorComponent text = { `Failed to simulate the stack due to error: "${ resolvedResults.visualizedSimulationState.jsonRpcError.error.message }". Please modify the stack to make it simutable.` }/>
				<RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } />
				<TransactionsAndSignedMessages
				simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
				removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
				activeAddress = { param.activeSimulationAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
				editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
				addressMetaData = { computedAddressBookEntries }
				displayMode = 'titleOnly'
				openSimulationStackAt = { param.openSimulationStack }
			/>
		</> : <>
			{ isEmpty.value ?
				<div style = 'padding: 10px'><DinoSays text = { 'Give me some transactions to munch on!' } /></div>
			: <>
				<div class = { param.simulationResultState.value === 'invalid' || param.simulationUpdatingState.value === 'failed' ? 'blur' : '' }>
					<RichAddressesTitleCard numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich.value } openSimulationStack = { param.openSimulationStack } />
					<TransactionsAndSignedMessages
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						removeTransactionOrSignedMessage = { param.removeTransactionOrSignedMessage }
						activeAddress = { param.activeSimulationAddress }
						renameAddressCallBack = { param.renameAddressCallBack }
						editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
						addressMetaData = { computedAddressBookEntries }
						displayMode = 'titleOnly'
						openSimulationStackAt = { param.openSimulationStack }
					/>
					{ param.removedTransactionOrSignedMessages.length > 0
						? <></>
						: <SimulationSummary
							simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
							currentBlockNumber = { param.currentBlockNumber }
							activeAddress = { param.activeSimulationAddress }
							renameAddressCallBack = { param.renameAddressCallBack }
							editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					}
				</div>
			</> }
		</> }
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

export function Home(param: HomeParams) {
	const { disableReset, resetSimulation, markSimulationDataReceived } = useResetSimulation()
	const removedTransactionOrSignedMessages = useSignal<readonly TransactionOrMessageIdentifier[]>([])
	const showPopupVisualisation = useSignal<boolean>(false)
	const tabWebsite = useComputed(() => param.tabState.value?.website)
	const disableResetUntilHomeDataLoaded = useComputed(() => disableReset.value || !param.isInitialHomeDataLoaded.value)

	const activeSimulationAddress = useComputed(() =>
		param.activeSimulationAddress.value !== undefined ? getActiveAddressEntry(param.activeSimulationAddress.value, param.activeAddresses.value) : undefined
	)
	const activeSigningAddress = useComputed(() =>
		param.activeSigningAddress.value !== undefined ? getActiveAddressEntry(param.activeSigningAddress.value, param.activeAddresses.value) : undefined
	)
	const currentActiveAddress = useComputed(() => param.simulationMode.value ? activeSimulationAddress.value : activeSigningAddress.value)

	useEffect(() => {
		if (!param.simulationMode.value || activeSimulationAddress.value === undefined) {
			showPopupVisualisation.value = false
			return
		}
		if (showPopupVisualisation.value) return
		return scheduleAfterPaint(() => {
			showPopupVisualisation.value = true
		})
	}, [param.simulationMode.value, activeSimulationAddress.value])

	useSignalEffect(() => {
		param.simVisResults.value
		markSimulationDataReceived()
		removedTransactionOrSignedMessages.value = []
	})

	async function removeTransactionOrSignedMessage(transactionOrMessageIdentifier: TransactionOrMessageIdentifier) {
		if (!param.isInitialHomeDataLoaded.value) return
		removedTransactionOrSignedMessages.value = [...removedTransactionOrSignedMessages.value, transactionOrMessageIdentifier]
		return await sendPopupMessageToBackgroundPage({ method: 'popup_removeTransactionOrSignedMessage', data: transactionOrMessageIdentifier })
	}

	async function disableInterceptorToggle() {
		if (!param.isInitialHomeDataLoaded.value) return
		if (param.tabState.value?.website === undefined) return
		const newValue = !param.interceptorDisabled.value
		await sendPopupMessageToBackgroundPage({ method: 'popup_setDisableInterceptor', data: { interceptorDisabled: newValue, website: param.tabState.value.website } })
	}

	async function resetSimulationAfterHomeDataLoaded() {
		if (!param.isInitialHomeDataLoaded.value) return
		await resetSimulation()
	}

	async function openSimulationStack(target?: TransactionOrMessageIdentifier) {
		await sendPopupMessageToBackgroundPage(target === undefined
			? { method: 'popup_openSimulationStack' }
			: { method: 'popup_openSimulationStack', data: target }
		)
		globalThis.close()
	}

	if (!param.isInitialHomeDataLoaded.value) {
		return <HomeLoadingSkeleton/>
	}
	if (param.rpcNetwork.value === undefined) return <></>

	return <>
		{ param.rpcNetwork.value.httpsRpc === undefined ?
			<ErrorComponent text = { `${ param.rpcNetwork.value.name } is not a supported network. The Interceptor is disabled while you are using ${ param.rpcNetwork.value.name }.` }/>
		: <></> }

		<FirstCard
			preSimulationBlockTimeManipulation = { param.preSimulationBlockTimeManipulation }
			activeAddresses = { param.activeAddresses }
			useSignersAddressAsActiveAddress = { param.useSignersAddressAsActiveAddress }
			activeAddress = { currentActiveAddress }
			rpcNetwork = { param.rpcNetwork }
			changeActiveRpc = { param.setActiveRpcAndInformAboutIt }
			simulationMode = { param.simulationMode }
			changeActiveAddress = { param.changeActiveAddress }
			makeCurrentAddressRich = { param.makeCurrentAddressRich }
			richNativeAmount = { param.richNativeAmount }
			richList = { param.fixedAddressRichList }
			richTokenOptions = { param.richTokenOptions }
			richAccountBalances = { param.richAccountBalances }
			tabState = { param.tabState }
			tabIconDetails = { param.tabIconDetails }
			renameAddressCallBack = { param.renameAddressCallBack }
			rpcEntries = { param.rpcEntries }
			isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }
			isFreshHomeDataLoaded = { param.isFreshHomeDataLoaded }
		/>

		{ param.simulationMode.value && activeSimulationAddress.value !== undefined
			? showPopupVisualisation.value
				? <PopupVisualisation
					simulationAndVisualisationResults = { param.simVisResults }
					removeTransactionOrSignedMessage = { removeTransactionOrSignedMessage }
					disableReset = { disableResetUntilHomeDataLoaded }
					resetSimulation = { resetSimulationAfterHomeDataLoaded }
					currentBlockNumber = { param.currentBlockNumber }
					activeSimulationAddress = { param.activeSimulationAddress }
					renameAddressCallBack = { param.renameAddressCallBack }
					editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }
					removedTransactionOrSignedMessages = { removedTransactionOrSignedMessages.value }
					rpcConnectionStatus = { param.rpcConnectionStatus }
					simulationUpdatingState = { param.simulationUpdatingState }
					simulationResultState = { param.simulationResultState }
					openSimulationStack = { openSimulationStack }
					numberOfAddressesMadeRich = { param.numberOfAddressesMadeRich }
				/>
				: <SimulationLoadingSkeleton/>
			: <></> }
		{ tabWebsite.value === undefined ? <></> : <>
			<div style = 'padding-top: 50px' />
			<div class = 'popup-footer popup-data-reveal' style = 'display: flex; justify-content: center; flex-direction: column;'>
				<div style = 'display: grid; grid-template-columns: auto auto; padding-left: 10px; padding-right: 10px' >
					<div class = 'log-cell' style = 'justify-content: left;'>
						<WebsiteOriginText website = { tabWebsite } />
					</div>
					<div class = 'log-cell' style = 'justify-content: right; padding-left: 20px'>
						<InterceptorDisabledButton website = { tabWebsite } disableInterceptorToggle = { disableInterceptorToggle } interceptorDisabled = { param.interceptorDisabled } isInitialHomeDataLoaded = { param.isInitialHomeDataLoaded }/>
					</div>
				</div>
			</div>
		</> }
	</>
}
