import type { HomeParams, FirstCardParams, SimulationStateParam, RenameAddressCallBack, TabState } from '../../types/user-interface-types.js'
import { type SimulationAndVisualisationResults, isEmptySimulationAndVisualisationResults } from '../../types/visualizer-types.js'
import { ActiveAddressComponent, SmallAddress, WebsiteOriginText, getActiveAddressEntry } from '../subcomponents/address.js'
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
import { BroomIcon, ChevronIcon, OpenInNewIcon, XMarkIcon } from '../subcomponents/icons.js'
import { RpcSelector } from '../subcomponents/ChainSelector.js'
import { type Signal, type ReadonlySignal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { type DeltaUnit, TimePicker, type TimePickerMode, getTimeManipulatorFromSignals } from '../subcomponents/TimePicker.js'
import { assertNever } from '../../utils/typescript.js'
import { addressString, bigintSecondsToDate } from '../../utils/bigint.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../simulation/services/SimulationModeEthereumClientService.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getMatchingRichTokenOptions, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { useResetSimulation } from '../hooks/useResetSimulation.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import type { ComponentChildren, JSX } from 'preact'
import { DropDownMenuButtonContent } from '../subcomponents/DropDownMenu.js'

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

function RichBalanceSummary({ profile, tokenOptions, nativeCurrencyTicker, onClick }: {
	profile: RichAccountBalance | undefined
	tokenOptions: readonly RichTokenOption[]
	nativeCurrencyTicker: string
	onClick: () => void
}) {
	if (profile === undefined) return <></>
	const tokenItems = profile.tokenBalances.flatMap((balance) => {
		const option = tokenOptions.find((candidate) => sameRichTokenIdentity(candidate, balance))
		return option === undefined ? [] : [{ key: `${ option.tokenAddress.toString() }:${ option.tokenId?.toString() ?? 'erc20' }`, label: option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`, logoUri: option.logoUri }]
	})
	const items = [{ key: 'native', label: nativeCurrencyTicker, logoUri: nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }, ...tokenItems]
	const visibleItems = items.slice(0, 3)
	return <button type = 'button' class = 'rich-mode-balance-summary' aria-label = { `Edit rich balances: ${ items.map((item) => item.label).join(', ') }` } onClick = { onClick }>
		{ visibleItems.map((item) => <span class = 'rich-mode-balance-summary-item' title = { item.label } key = { item.key }>
			{ item.logoUri === undefined
				? <span class = 'rich-mode-balance-summary-monogram' aria-hidden = 'true'>{ item.label.slice(0, 2) }</span>
				: <img class = 'rich-mode-balance-summary-icon' src = { item.logoUri } width = '14' height = '14' aria-hidden = 'true'/>
			}
			<span>{ item.label }</span>
		</span>) }
		{ items.length <= visibleItems.length ? <></> : <span class = 'rich-mode-balance-summary-overflow'>+{ (items.length - visibleItems.length).toString() }</span> }
	</button>
}

function RichList({ makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, chainId, renameAddressCallBack, isInitialHomeDataLoaded }: RichListParams) {
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
	const richTokenError = useSignal<string | undefined>(undefined)
	const richTokenPending = useSignal(false)
	const richTokenPendingLabel = useSignal<string | undefined>(undefined)
	const richTokenSearch = useSignal('')
	const showRichBalanceDialog = useSignal(false)
	const showRichTokenPicker = useSignal(false)
	const selectedRichTokenKeys = useSignal<readonly string[]>([])
	const newlyAddedRichTokenKey = useSignal<string | undefined>(undefined)
	const selectedRichAddress = useSignal<bigint | undefined>(undefined)
	const getRichTokenLabel = (option: RichTokenOption) => option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`
	const getRichTokenKey = (option: RichTokenOption) => `${ option.tokenAddress.toString() }:${ option.tokenId?.toString() ?? 'erc20' }`
	const updateProfileForAddress = (address: bigint, update: (profile: RichAccountBalance) => RichAccountBalance) => {
		richAccountBalances.value = richAccountBalances.value.map((profile) => profile.chainId === chainId && profile.address === address ? update(profile) : profile)
	}

	const setRichTokenEnabled = async (option: RichTokenOption, enabled: boolean, targetAddress?: bigint) => {
		const address = targetAddress ?? selectedRichAccount.value?.addressBookEntry.address
		if (richTokenPending.value || address === undefined) return false
		richTokenPending.value = true
		richTokenPendingLabel.value = enabled
			? `Preparing ${ getRichTokenLabel(option) }…`
			: `Removing ${ getRichTokenLabel(option) } from rich mode…`
		richTokenError.value = undefined
		const reply = await sendPopupMessageWithReply({
			method: 'popup_modifyRichToken',
			data: { action: enabled ? 'Add' : 'Remove', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId },
		})
		richTokenPending.value = false
		richTokenPendingLabel.value = undefined
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			return false
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
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
		return true
	}

	const addSelectedRichTokens = async () => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined || richTokenPending.value) return
		const options = availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenKey(option)))
		if (options.length === 0) return
		const addedKeys: string[] = []
		for (const option of options) {
			if (!await setRichTokenEnabled(option, true, address)) break
			addedKeys.push(getRichTokenKey(option))
		}
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.filter((key) => !addedKeys.includes(key))
		if (addedKeys.length !== options.length) return
		newlyAddedRichTokenKey.value = addedKeys[0]
		richTokenSearch.value = ''
		showRichTokenPicker.value = false
	}

	const setNativeAmount = (input: HTMLInputElement) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		const profile = selectedRichProfile.value
		if (address === undefined || profile === undefined) return
		richTokenError.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, 18n)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? `${ nativeCurrencyTicker } amount cannot exceed the maximum uint256 value.`
				: `Enter a positive ${ nativeCurrencyTicker } amount with at most 18 decimal places.`
			input.value = formatUnits(profile.nativeAmount, 18)
			return
		}
		updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: parsedAmount.amount }))
		void sendPopupMessageToBackgroundPage({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: parsedAmount.amount, address } })
	}

	const setRichTokenAmount = async (option: RichTokenOption, input: HTMLInputElement) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined) return
		richTokenError.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, option.decimals)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? 'Token amount cannot exceed the maximum uint256 value.'
				: `Enter a positive ${ option.symbol } amount with at most ${ option.decimals.toString() } decimal places.`
			input.value = formatUnits(option.amount, Number(option.decimals))
			return
		}
		const amount = parsedAmount.amount
		if (richTokenPending.value) {
			input.value = formatUnits(option.amount, Number(option.decimals))
			return
		}
		richTokenPending.value = true
		richTokenPendingLabel.value = `Saving ${ getRichTokenLabel(option) } amount…`
		const reply = await sendPopupMessageWithReply({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount } })
		richTokenPending.value = false
		richTokenPendingLabel.value = undefined
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			return
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
			return
		}
		updateProfileForAddress(address, (profile) => ({ ...profile, tokenBalances: profile.tokenBalances.map((balance) => sameRichTokenIdentity(balance, option) ? { ...balance, amount } : balance) }))
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
	const selectedRichAccount = useComputed(() => richAccounts.value.find((element) => element.addressBookEntry.address === selectedRichAddress.value))
	useSignalEffect(() => {
		const selectedAddress = selectedRichAddress.value
		if (selectedAddress === undefined || richAccounts.value.some((account) => account.addressBookEntry.address === selectedAddress)) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		richTokenSearch.value = ''
		selectedRichTokenKeys.value = []
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
	const matchingAvailableRichTokens = useComputed(() => getMatchingRichTokenOptions(availableRichTokens.value, richTokenSearch.value))
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
		richTokenSearch.value = ''
		selectedRichTokenKeys.value = []
		newlyAddedRichTokenKey.value = undefined
		richTokenError.value = undefined
	}
	const closeRichBalanceDialog = () => {
		if (richTokenPending.value) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		richTokenSearch.value = ''
		selectedRichTokenKeys.value = []
		newlyAddedRichTokenKey.value = undefined
		richTokenError.value = undefined
	}
	const showRichTokenSelection = () => {
		richTokenSearch.value = ''
		selectedRichTokenKeys.value = []
		newlyAddedRichTokenKey.value = undefined
		richTokenError.value = undefined
		showRichTokenPicker.value = true
	}
	const hideRichTokenSelection = () => {
		if (richTokenPending.value) return
		showRichTokenPicker.value = false
		richTokenSearch.value = ''
		selectedRichTokenKeys.value = []
		richTokenError.value = undefined
	}
	const toggleRichTokenSelection = (option: RichTokenOption) => {
		const key = getRichTokenKey(option)
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.includes(key)
			? selectedRichTokenKeys.value.filter((selectedKey) => selectedKey !== key)
			: [...selectedRichTokenKeys.value, key]
	}

	const numberOfRichAddresses = useComputed(() => richList.value.filter((element) => element.makingRich).length)

	return <>
		<header class = 'card-header' style = 'cursor: pointer;' onClick = { () => { showList.value = !showList.value } }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em; padding: 0 0.5rem;'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content;' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { makeCurrentAddressRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeCurrentAddressRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Make current account rich</p>
				</label>
			</p>
			<div class = 'card-header-icon noselect' style = 'cursor: pointer;'>
				{ numberOfRichAddresses.value === 0 ? <></> : <p class = 'paragraph checkbox-text' style = 'white-space: nowrap; color: gray; padding-right: 10px;'> (+{ numberOfRichAddresses.value } rich address{ numberOfRichAddresses.value > 1 ? 'es' : '' })</p> }
				<span class = 'icon'><ChevronIcon /></span>
			</div>
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
			: <div class = 'card-content'>
				<div style = { { display: 'flex', flexDirection: 'column' } } >
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap; font-weight: 600;'> Accounts</p>
					<div aria-label = 'Additional rich accounts' class = 'rich-mode-account-list'>
						{ visibleRichList.value.map((richListElement) => {
							const accountIsRich = richAccounts.value.some((account) => account.addressBookEntry.address === richListElement.addressBookEntry.address)
							const accountProfile = richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === richListElement.addressBookEntry.address)
							const isCurrentAddressRow = richListElement.type === 'CurrentActiveAddress'
							return <div class = 'rich-mode-account-row' key = { richListElement.addressBookEntry.address.toString() }>
								<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { isCurrentAddressRow ? makeCurrentAddressRich.value : richListElement.makingRich } aria-label = { `Toggle rich address ${ richListElement.addressBookEntry.address.toString() }` } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { isCurrentAddressRow ? enableMakeCurrentAddressRich(e.target.checked) : modifyRichList(richListElement.addressBookEntry, e.target.checked) } } } />
								<div class = 'rich-mode-account-details'>
									<SmallAddress addressBookEntry = { richListElement.addressBookEntry } renameAddressCallBack = { renameAddressCallBack } noCopying = { !isInitialHomeDataLoaded.value } noEditAddress = { !isInitialHomeDataLoaded.value }/>
									{ !accountIsRich ? <></> : <RichBalanceSummary profile = { accountProfile } tokenOptions = { richTokenOptions.value } nativeCurrencyTicker = { nativeCurrencyTicker } onClick = { () => { selectedRichAddress.value = richListElement.addressBookEntry.address; showRichBalanceDialog.value = true } }/> }
								</div>
								<button type = 'button' class = 'btn btn--ghost is-small rich-mode-balance-action' disabled = { !accountIsRich } aria-label = { `Edit balances for ${ richListElement.addressBookEntry.name }` } onClick = { () => { selectedRichAddress.value = richListElement.addressBookEntry.address; showRichBalanceDialog.value = true } }>Balances</button>
							</div>
						}) }
					</div>
				</div>
			</div>
		}
		{ !showRichBalanceDialog.value || selectedRichAccount.value === undefined
			? <></>
			: <div
				class = 'modal is-active rich-mode-modal-layer'
				aria-modal = 'true'
				role = 'dialog'
				aria-label = { showRichTokenPicker.value ? `Select tokens for ${ selectedRichAccount.value.addressBookEntry.name }` : `Balance editor for ${ selectedRichAccount.value.addressBookEntry.name }` }
				onKeyDown = { event => {
					if (event.key !== 'Escape' || richTokenPending.value) return
					showRichTokenPicker.value ? hideRichTokenSelection() : closeRichBalanceDialog()
				} }
			>
				<div class = 'modal-background' onClick = { closeRichBalanceDialog }/>
				<div class = 'modal-card rich-mode-modal-card'>
					<header class = 'modal-card-head card-header interceptor-modal-head window-header rich-mode-modal-head'>
						{ showRichTokenPicker.value
							? <button type = 'button' class = 'card-header-icon rich-mode-modal-back' aria-label = 'Back to balances' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>‹</button>
							: <div class = 'card-header-icon unset-cursor'><span class = 'icon'><img src = '../img/address-book.svg' width = '24' height = '24'/></span></div>
						}
						<div class = 'card-header-title'>
							<p class = 'paragraph'>{ showRichTokenPicker.value ? 'Select tokens' : 'Balances' }</p>
							<p class = 'rich-mode-modal-account'>{ selectedRichAccount.value.addressBookEntry.name }</p>
						</div>
						<button type = 'button' class = 'card-header-icon' aria-label = 'Close balance editor' disabled = { richTokenPending.value } onClick = { closeRichBalanceDialog }><XMarkIcon/></button>
					</header>
					<section class = 'modal-card-body'>
						<div class = 'card rich-mode-modal-content'>
							<div class = 'card-content'>
							{ showRichTokenPicker.value ? <>
								<div class = 'field rich-mode-token-search'>
									<div class = 'control'>
										<input
											class = 'input'
											type = 'search'
											autoFocus = { true }
											aria-label = 'Search address-book tokens'
											placeholder = { `Search ${ availableRichTokens.value.length.toString() } address-book token${ availableRichTokens.value.length === 1 ? '' : 's' }…` }
											disabled = { richTokenPending.value }
											value = { richTokenSearch.value }
											onInput = { event => { richTokenSearch.value = event.currentTarget.value } }
										/>
									</div>
								</div>
								<div aria-label = 'Matching address-book tokens' class = 'rich-mode-token-results'>
									{ matchingAvailableRichTokens.value.map((option) => {
										const selected = selectedRichTokenKeys.value.includes(getRichTokenKey(option))
										return <button
											type = 'button'
											data-rich-token-result = { getRichTokenKey(option) }
											class = { `btn btn--ghost rich-mode-token-result${ selected ? ' is-selected' : '' }` }
											disabled = { richTokenPending.value }
											aria-label = { `Select rich token ${ getRichTokenLabel(option) } ${ addressString(option.tokenAddress) }` }
											aria-pressed = { selected }
											onClick = { () => { toggleRichTokenSelection(option) } }
											key = { getRichTokenKey(option) }
										>
											<RichTokenIcon class = 'rich-mode-token-result-icon' label = { option.symbol } logoUri = { option.logoUri }/>
											<span class = 'rich-mode-token-result-details'>
												<strong>{ getRichTokenLabel(option) }</strong>
												<span>{ option.name }</span>
												<small>{ addressString(option.tokenAddress) }</small>
											</span>
											<span
												class = { `rich-mode-token-layout-status${ option.balanceSlot === undefined ? '' : ' is-ready' }` }
												aria-label = { option.balanceSlot === undefined ? 'Storage discovery required' : 'Storage layout ready' }
												data-tooltip = { option.balanceSlot === undefined ? 'Storage discovery required' : 'Storage layout ready' }
											>{ option.balanceSlot === undefined ? '?' : '✓' }</span>
											<span class = 'rich-mode-token-selection-mark' aria-hidden = 'true'>{ selected ? '✓' : '' }</span>
										</button>
									}) }
									{ matchingAvailableRichTokens.value.length === 0 ? <p class = 'help'>No matching tokens in the active-chain address book.</p> : <></> }
								</div>
							</> : <>
								{ richAccounts.value.length < 2 ? <></> : <div class = 'rich-mode-account-switcher' aria-label = 'Rich account navigation'>
									<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Previous rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(-1) } }>‹</button>
									<span>{ (selectedRichAccountIndex.value + 1).toString() } of { richAccounts.value.length.toString() }</span>
									<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Next rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(1) } }>›</button>
								</div> }
								<div class = 'rich-mode-modal-toolbar'>
									<p class = 'paragraph checkbox-text rich-mode-modal-section-title'>Amounts</p>
									<div class = 'actions'>
										<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Open token address book' data-tooltip = 'Open token address book' onClick = { () => { void sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' }) } }>
											<span class = 'icon'><img src = '../img/address-book.svg' width = '18' height = '18'/></span>
										</button>
										<button type = 'button' class = 'btn btn--outline is-small' aria-label = 'Select tokens' disabled = { richTokenPending.value || selectedRichProfile.value === undefined || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select tokens</button>
									</div>
								</div>
								{ selectedRichProfile.value === undefined ? <p class = 'help'>This account has no balance profile.</p> : <>
									<div class = 'rich-mode-balance-row rich-mode-balance-row--native'>
										<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { nativeCurrencyTicker } logoUri = { nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }/>
										<span class = 'rich-mode-balance-token-name'><strong>{ nativeCurrencyTicker }</strong><small>Native currency</small></span>
										<div class = 'rich-mode-amount-with-unit'>
											<input class = 'input is-small' aria-label = { `${ nativeCurrencyTicker } rich amount for ${ selectedRichAccount.value.addressBookEntry.name }` } disabled = { richTokenPending.value } value = { formatUnits(selectedRichProfile.value.nativeAmount, 18) } onChange = { event => { setNativeAmount(event.currentTarget) } } />
											<span class = 'rich-mode-amount-unit' aria-hidden = 'true'>{ nativeCurrencyTicker }</span>
										</div>
										<span/>
									</div>
									<div aria-busy = { richTokenPending.value } aria-label = 'Configured rich tokens' class = 'rich-mode-configured-tokens'>
										{ enabledRichTokens.value.map((option) => <div class = 'rich-mode-balance-row' key = { getRichTokenKey(option) }>
											<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { option.symbol } logoUri = { option.logoUri }/>
											<span class = 'rich-mode-balance-token-name'><strong>{ getRichTokenLabel(option) }</strong><small>{ option.name }</small></span>
											<div class = 'rich-mode-amount-with-unit'>
												<input autoFocus = { newlyAddedRichTokenKey.value === getRichTokenKey(option) } class = 'input is-small' aria-label = { `${ getRichTokenLabel(option) } rich amount` } disabled = { !option.enabled || richTokenPending.value } value = { formatUnits(option.amount, Number(option.decimals)) } onChange = { event => { void setRichTokenAmount(option, event.currentTarget) } } />
												<span class = 'rich-mode-amount-unit' aria-hidden = 'true'>{ option.symbol }</span>
											</div>
											<button type = 'button' class = 'delete is-small rich-mode-remove-token' disabled = { richTokenPending.value } aria-label = { `Remove rich token ${ getRichTokenLabel(option) }` } onClick = { () => { void setRichTokenEnabled(option, false) } } />
										</div>) }
									</div>
								</> }
							</> }
							{ richTokenPendingLabel.value === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenPendingLabel.value }</p> }
							{ richTokenError.value === undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
							</div>
						</div>
					</section>
					<footer class = 'modal-card-foot window-footer rich-mode-modal-footer'>
						{ showRichTokenPicker.value ? <>
							<button type = 'button' class = 'btn btn--ghost' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>Cancel</button>
							<span class = 'rich-mode-token-selection-count'>{ selectedAvailableRichTokens.value.length.toString() } selected</span>
							<button type = 'button' class = 'btn btn--primary' aria-label = 'Add selected tokens' disabled = { richTokenPending.value || selectedAvailableRichTokens.value.length === 0 } onClick = { () => { void addSelectedRichTokens() } }>Add { selectedAvailableRichTokens.value.length === 0 ? '' : selectedAvailableRichTokens.value.length.toString() } token{ selectedAvailableRichTokens.value.length === 1 ? '' : 's' }</button>
						</> : <button type = 'button' class = 'btn btn--outline' disabled = { richTokenPending.value } onClick = { closeRichBalanceDialog }>Close</button> }
					</footer>
				</div>
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
