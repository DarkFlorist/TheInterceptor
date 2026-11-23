import { type ReadonlySignal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { RichTokenSimulationRefresh } from '../../types/interceptor-reply-messages.js'
import type { RichTokenOption } from '../../types/richMode.js'
import { getRichTokenIdentityKey, getRichTokenLabel } from '../../utils/richTokens.js'
import { assertNever } from '../../utils/typescript.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import type { ChangeRichSettings } from '../popupSettingsChange.js'
import type { RichFundingFeedback } from '../subcomponents/RichModeShared.js'

const SAVED_WITH_NEWER_REFRESH_PENDING_MESSAGE = 'The token funding was saved. A newer simulation refresh is in progress; its result will update the simulation.'

export type RichModeMutationInputs = {
	isSettingsChangePending: ReadonlySignal<boolean>
	changeRichSettings: ChangeRichSettings
	richFundingChainId: ReadonlySignal<bigint | undefined>
	isInitialHomeDataLoaded: ReadonlySignal<boolean>
	nativeCurrencyTicker: string
}

// Runs rich-funding changes against the background: one change at a time, its progress and outcome feedback, and the home-data reload that follows every change.
export function useRichModeMutations({ isSettingsChangePending, changeRichSettings, richFundingChainId, isInitialHomeDataLoaded, nativeCurrencyTicker }: RichModeMutationInputs) {
	const { value: richChangeState, waitFor: waitForRichChange } = useAsyncState<void>()
	const operationPending = useSignal(false)
	const pendingKey = useSignal<string | undefined>(undefined)
	const pendingLabel = useSignal<string | undefined>(undefined)
	const error = useSignal<string | undefined>(undefined)
	const errorTarget = useSignal<string | undefined>(undefined)
	const notice = useSignal<string | undefined>(undefined)
	const saveConfirmedAddress = useSignal<bigint | undefined>(undefined)
	const mutationPending = useComputed(() => isSettingsChangePending.value || operationPending.value || richChangeState.value.state === 'pending')
	const controlsDisabled = useComputed(() => richFundingChainId.value === undefined || !isInitialHomeDataLoaded.value || mutationPending.value)

	useSignalEffect(() => {
		const savedAddress = saveConfirmedAddress.value
		if (savedAddress === undefined) return
		// The pinned signals hook forwards this cleanup to the core effect; the identity guard also protects a callback already queued before cancellation.
		let active = true
		const timeout = globalThis.setTimeout(() => { if (active && saveConfirmedAddress.peek() === savedAddress) saveConfirmedAddress.value = undefined }, 1600)
		return () => { active = false; globalThis.clearTimeout(timeout) }
	})

	const reloadRichState = async () => await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: false } })
	const setError = (message: string | undefined, target: string | undefined) => {
		error.value = message
		errorTarget.value = target
	}
	const clearFeedback = () => {
		setError(undefined, undefined)
		notice.value = undefined
	}

	const saveRichChange = (enabled: boolean, address: bigint | 'CurrentAddress') => {
		void waitForRichChange(async () => {
			try {
				const result = await changeRichSettings({ method: 'popup_modifyMakeMeRich', data: { action: 'set-address-rich', add: enabled, address } })
				// The async state shows a rejected change as its error.
				if (!result.ok) throw new Error(result.error)
			} finally {
				// Reload persisted balances after failures too, because a saved setting may not have been visualized.
				await reloadRichState()
			}
		})
	}

	const reportSimulationRefreshOutcome = (simulationRefresh: RichTokenSimulationRefresh | undefined) => {
		switch (simulationRefresh) {
			case undefined:
			case 'Refreshed': return
			case 'Superseded': {
				notice.value = SAVED_WITH_NEWER_REFRESH_PENDING_MESSAGE
				return
			}
			default: return assertNever(simulationRefresh)
		}
	}

	const runRichOperation = async <Result,>(key: string, label: string, operation: () => Promise<Result>) => {
		operationPending.value = true
		pendingKey.value = key
		pendingLabel.value = label
		saveConfirmedAddress.value = undefined
		clearFeedback()
		try {
			let result: Result | undefined
			try {
				result = await operation()
			} catch (caught) {
				setError(caught instanceof Error ? caught.message : 'The funding change could not be completed.', key)
			}
			// A missing reply may follow a committed write, so refresh persisted funding on failures too.
			await reloadRichState()
			return result
		} finally {
			operationPending.value = false
			pendingKey.value = undefined
			pendingLabel.value = undefined
		}
	}

	// Adds or removes one token's funding for an account; returns whether the change was saved.
	const changeTokenFunding = async (option: RichTokenOption, enabled: boolean, address: bigint, chainId: bigint) => {
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(
			tokenKey,
			enabled ? `Preparing ${ getRichTokenLabel(option) }…` : `Removing ${ getRichTokenLabel(option) } from rich mode…`,
			async () => await changeRichSettings({
				method: 'popup_modifyRichToken',
				data: { action: enabled ? 'Add' : 'Remove', chainId, address, tokenAddress: option.tokenAddress, tokenId: option.tokenId },
			}),
		)
		if (reply === undefined) {
			error.value ??= 'The background service did not return a token funding result.'
			errorTarget.value = tokenKey
			return false
		}
		if (!reply.ok) {
			setError(reply.error, tokenKey)
			return false
		}
		saveConfirmedAddress.value = address
		reportSimulationRefreshOutcome(reply.simulationRefresh)
		return true
	}

	const saveNativeAmount = async (address: bigint, chainId: bigint, amount: bigint) => {
		const reply = await runRichOperation('native', `Saving ${ nativeCurrencyTicker } amount…`, async () => await changeRichSettings({ method: 'popup_modifyMakeMeRich', data: { action: 'set-native-amount', chainId, nativeAmount: amount, address } }))
		if (reply?.ok === true) {
			saveConfirmedAddress.value = address
			return
		}
		error.value ??= reply === undefined ? 'The background service did not confirm the native balance.' : reply.error
		errorTarget.value = 'native'
	}

	const saveTokenAmount = async (option: RichTokenOption, address: bigint, chainId: bigint, amount: bigint) => {
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(tokenKey, `Saving ${ getRichTokenLabel(option) } amount…`, async () => await changeRichSettings({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', chainId, address, tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount } }))
		if (reply === undefined) {
			error.value ??= 'The background service did not return a token funding result.'
			errorTarget.value = tokenKey
			return
		}
		if (!reply.ok) {
			setError(reply.error, tokenKey)
			return
		}
		saveConfirmedAddress.value = address
		reportSimulationRefreshOutcome(reply.simulationRefresh)
	}

	const feedback: ReadonlySignal<RichFundingFeedback> = useComputed(() => ({
		richTokenError: error.value,
		richTokenErrorTarget: errorTarget.value,
		richTokenPending: mutationPending.value,
		richTokenPendingKey: pendingKey.value,
		richTokenNotice: notice.value,
		richTokenPendingLabel: pendingLabel.value,
	}))

	return {
		richChangeState, operationPending, error, saveConfirmedAddress, controlsDisabled, feedback,
		saveRichChange, changeTokenFunding, saveNativeAmount, saveTokenAmount, setError, clearFeedback,
	}
}
