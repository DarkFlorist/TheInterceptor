import { createContext, type ComponentChildren } from 'preact'
import { useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useContext, useRef } from 'preact/hooks'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { TextInput } from './TextField.js'
import type { RpcEntries, RpcEntry } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport } from '../../background/backgroundUtils.js'
import { getSettings } from '../../background/settings.js'
import { getChainName } from '../../utils/constants.js'
import { useRpcConnectionsList } from '../pages/SettingsView.js'
import { EthereumJSONRpcRequestHandler } from '../../simulation/services/EthereumJSONRpcRequestHandler.js'
import { type EthSimulateV1Params, EthSimulateV1Result } from '../../types/ethSimulate-types.js'
import { JsonRpcResponseError } from '../../utils/errors.js'
import { EthereumQuantity } from '../../types/wire-types.js'
import { isBrowserFetchTransportError } from '../../utils/caughtErrors.js'
import { AsyncStatusIcon } from './AsyncAction.js'
import { parseRpcFormData } from '../../utils/rpcFormData.js'
import { ErrorComponent } from './Error.js'

type RpcProbeResult = {
	chainId: bigint
}

type ConfigureRpcContext = {
	queryRpcInfo: (url: string) => void
	rpcQuery: ReturnType<typeof useAsyncState<RpcProbeResult>>['value']
	resetRpcQuery: () => void
}

const ConfigureRpcContext = createContext<ConfigureRpcContext | undefined>(undefined)

const throwImprovedError = (error: unknown, url: string, fallbackMessage: string) => {
	const message = error instanceof Error ? error.message : undefined
	if (message?.startsWith('unsupported protocol')) throw new Error(`Unsupported protocol, did you mean https://${ url }?`)
	if (isBrowserFetchTransportError(error)) throw new Error('Failed to connect to the RPC.')
	if (!(error instanceof Error)) throw new Error(fallbackMessage)
	throw error
}

const RpcQueryProvider = ({ children }: { children: ComponentChildren }) => {
	const { value: rpcQuery, waitFor, reset: resetRpcQuery } = useAsyncState<RpcProbeResult>()

	const checkServerAvailability = async (url: string) => {
		try {
			const requestHandler = new EthereumJSONRpcRequestHandler(url)
			const chainId = await requestHandler.jsonRpcRequest({ method: 'eth_chainId' }, undefined, false, 10000)
			return { chainId: EthereumQuantity.parse(chainId) }
		} catch(error: unknown) {
			return throwImprovedError(error, url, 'Unable to fetch network information from the RPC.')
		}
	}

	const validateEthSimulateSupport = async (url: string) => {
		// test eth_simulate request
		const requestHandler = new EthereumJSONRpcRequestHandler(url)
		const ethSimulateV1ParamObject: EthSimulateV1Params['params'][0] = {
			blockStateCalls: [{
				blockOverrides: {
					baseFeePerGas: 0x9n
				},
				stateOverrides: {
					'0xc000000000000000000000000000000000000000': {
						balance: 0x1312d0000n,
					}
				},
				calls: [
					{
						from: 0xc000000000000000000000000000000000000000n,
						to: 0xc000000000000000000000000000000000000000n,
						value: 0x1n,
						maxFeePerGas: 0xfn,
					}
				]
			}],
			validation: true,
			traceTransfers: true
		}

		try {
			const serializedResult = await requestHandler.jsonRpcRequest({
				method: 'eth_simulateV1',
				params: [ethSimulateV1ParamObject, 'latest']
			})

			function resultContainsLog(result: ReturnType<typeof EthSimulateV1Result.safeParse>) {
				return Boolean(result.success && result.value && result.value[0] && result.value[0].calls[0] && result.value[0].calls[0].status === 'success' && result.value[0].calls[0].logs.length === 1)
			}

			const parsedResult = EthSimulateV1Result.safeParse(serializedResult)

			if (!resultContainsLog(parsedResult)) throw new Error(`The RPC server does not have a support for eth_simulateV1 (it doesn't return ETH logs). The Interceptor requires this feature to function.`)
		} catch (error: unknown) {
			if (error instanceof JsonRpcResponseError) throw new Error(`The RPC server does not have a support for eth_simulateV1 ("${ error.message }"). The Interceptor requires this feature to function.`)
			return throwImprovedError(error, url, 'The RPC server does not have a support for eth_simulateV1. The Interceptor requires this feature to function.')
		}
	}

	const queryRpcInfo = (url: string) => waitFor(async () => {
		const network = await checkServerAvailability(url.trim())
		await validateEthSimulateSupport(url.trim())
		return network
	})

	return <ConfigureRpcContext.Provider value = { { queryRpcInfo, rpcQuery, resetRpcQuery } }>{ children }</ConfigureRpcContext.Provider>
}

function useQueryRpc() {
	const context = useContext(ConfigureRpcContext)
	if (!context) throw new Error('useQueryRpc can only be used within children of RpcQueryProvider')
	return context
}

export const ConfigureRpcConnection = ({ rpcInfo }: { rpcInfo?: RpcEntry }) => {
	const rpcEntries = useRpcConnectionsList()
	const modalRef = useRef<HTMLDialogElement>(null)

	const showConfigurationModal = () => modalRef.current?.showModal()

	const cancelAndCloseModal = () => modalRef.current?.close()

	const saveRpcEntry = async (rpcEntry: RpcEntry) => {
		const { activeRpcNetwork } = await getSettings()
		await saveRpcEntryAndKeepActiveRpcConsistent(rpcEntry, rpcEntries.value, activeRpcNetwork,
			async (entries) => await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_set_rpc_list', data: entries }),
			async (entry) => await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_changeActiveRpc', data: entry })
		)
	}

	const removeRpcEntryByUrl = async (url: string) => {
		const { activeRpcNetwork } = await getSettings()
		await removeRpcEntryAndKeepActiveRpcConsistent(url, rpcEntries.value, activeRpcNetwork,
			async (entries) => await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_set_rpc_list', data: entries }),
			async (entry) => await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport({ method: 'popup_changeActiveRpc', data: entry })
		)
	}

	return (
		<RpcQueryProvider>
			{ rpcInfo
				? <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline'>Edit</button>
				: <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline rpc-add-button'>+ New RPC Connection</button>
			}
			<dialog class = 'dialog' ref = { modalRef }>
				<ConfigureRpcForm defaultValues = { rpcInfo } onCancel = { cancelAndCloseModal } onSave = { saveRpcEntry } onRemove = { rpcEntries.value.length > 1 ? removeRpcEntryByUrl : undefined } />
			</dialog>
		</RpcQueryProvider>
	)
}

type PersistRpcEntries = (entries: RpcEntries) => Promise<void>
type ChangeActiveRpc = (entry: RpcEntry) => Promise<void>
type ActiveRpcSelection = { readonly httpsRpc: string | undefined, readonly chainId: bigint }

export async function saveRpcEntryAndKeepActiveRpcConsistent(rpcEntry: RpcEntry, rpcEntries: RpcEntries, activeRpcNetwork: ActiveRpcSelection, persistRpcEntries: PersistRpcEntries, changeActiveRpc: ChangeActiveRpc) {
	const updatedRpcEntries = [rpcEntry].concat(rpcEntries.filter(entry => entry.httpsRpc !== rpcEntry.httpsRpc))
	if (activeRpcNetwork.httpsRpc === rpcEntry.httpsRpc) {
		if (activeRpcNetwork.chainId !== rpcEntry.chainId) throw new Error('Switch to another RPC before changing the active connection chain ID.')
		console.warn(`Automatically switched to recently added or modified RPC (${ rpcEntry.httpsRpc })`)
		await changeActiveRpc(rpcEntry)
	}
	await persistRpcEntries(updatedRpcEntries)
}

export async function removeRpcEntryAndKeepActiveRpcConsistent(url: string, rpcEntries: RpcEntries, activeRpcNetwork: ActiveRpcSelection, persistRpcEntries: PersistRpcEntries, changeActiveRpc: ChangeActiveRpc) {
	const reducedRpcEntries = rpcEntries.filter(entry => entry.httpsRpc !== url)
	if (url === activeRpcNetwork.httpsRpc) {
		const rpcToSwitchTo = reducedRpcEntries.find(entry => entry.chainId === activeRpcNetwork.chainId)
		if (rpcToSwitchTo === undefined) throw new Error('Switch to another RPC on this chain before removing the active connection.')
		console.warn('Switching RPC as a result of the removal of the currently active connection')
		await changeActiveRpc(rpcToSwitchTo)
	}
	await persistRpcEntries(reducedRpcEntries)
}

type ConfigureRpcFormProps = {
	defaultValues?: RpcEntry,
	onCancel: () => void
	onSave: (rpcEntry: RpcEntry) => Promise<void>
	onRemove?: (rpcUrl: string) => Promise<void>
}

export async function completeRpcFormMutation(mutation: () => Promise<void>, onSuccess: () => void) {
	await mutation()
	onSuccess()
}

const ConfigureRpcForm = ({ defaultValues, onCancel, onSave, onRemove }: ConfigureRpcFormProps) => {
	const confirmRemoval = useSignal(false)
	const { rpcQuery, resetRpcQuery } = useQueryRpc()
	const { value: mutationState, waitFor: waitForMutation } = useAsyncState<void>()
	const mutationPending = mutationState.value.state === 'pending'

	const completeForm = (form: HTMLFormElement) => {
		resetRpcQuery()
		form.reset()
		onCancel()
	}

	const handleFormSubmit = (event: Event) => {
		// TODO: current version preact don't ship with SubmitEvent type
		if (!(event instanceof SubmitEvent)) return
		if (!(event.target instanceof HTMLFormElement)) return
		const form = event.target
		event.preventDefault()

		if (event.submitter instanceof HTMLButtonElement) {
			switch (event.submitter.value) {
				case 'cancel':
					onCancel()
					resetRpcQuery()
					form.reset()
					return

				case 'remove':
					if (defaultValues !== undefined && onRemove !== undefined) {
						void waitForMutation(async () => await completeRpcFormMutation(
							async () => await onRemove(defaultValues.httpsRpc),
							() => completeForm(form)
						))
					}
					return

				case 'save':
					void waitForMutation(async () => await completeRpcFormMutation(async () => {
						const parsedData = parseRpcFormData(new FormData(form))
						if (!parsedData.success) throw new Error(parsedData.message)
						await onSave(parsedData.value)
					}, () => completeForm(form)))
					return
			}
		}
	}

	const chainIdDefault = useComputed(() => {
		if (rpcQuery.value.state === 'resolved') return BigInt(rpcQuery.value.value.chainId).toString()
		return defaultValues?.chainId?.toString() || ''
	})

	const networkNameDefault = useComputed(() => {
		if (rpcQuery.value.state !== 'resolved') return defaultValues?.name || ''
		return getChainName(rpcQuery.value.value.chainId)
	})

	const currencyTickerDefault = useComputed(() => {
		if (rpcQuery.value.state === 'resolved') return defaultValues?.currencyTicker || 'ETH'
		return defaultValues?.currencyTicker || ''
	})

	const currencyNameDefault = useComputed(() => {
		if (rpcQuery.value.state === 'resolved') return defaultValues?.currencyName || 'Ether'
		return defaultValues?.currencyName || ''
	})

	const blockExplorerUrlDefault = useComputed(() => defaultValues?.blockExplorer?.apiUrl || '')
	const blockExplorerApiKeyDefault = useComputed(() => defaultValues?.blockExplorer?.apiKey || '')

	return (
		<form method = 'dialog' class = 'grid' style = '--gap-y: 1.5rem' onSubmit = { handleFormSubmit }>
			<header class = 'grid' style = '--grid-cols: 1fr auto'>
				<span style = { { fontWeight: 'bold', color: 'white' } }>Configure RPC Connection</span>
				<button type = 'submit' value = 'cancel' class = 'btn btn--ghost' aria-label = 'close' formNoValidate disabled = { mutationPending }>
					<span class = 'button-icon' style = { { fontSize: '1.5em' } }>&times;</span>
				</button>
			</header>

			<main class = 'grid' style = '--gap-y: 0.5rem'>
				<p>Interceptor will automatically verify the RPC URL you provide and attempt to fill relevant information. Adjust the pre-populated details to your liking.</p>
				<div class = 'grid' style = '--grid-cols: 1fr 1fr; --gap-x: 1rem; --gap-y: 0' >
					<RpcUrlField { ...(defaultValues?.httpsRpc !== undefined ? { defaultValue: defaultValues.httpsRpc } : {}) } />
					<TextInput label = 'RPC Connection Name *' name = 'name' defaultValue = { networkNameDefault.value } style = '--area: 5 / span 1' required autoFocus />
					<TextInput label = 'Chain ID' name = 'chainId' style = '--area: 5 / span 1' defaultValue = { chainIdDefault.value } required readOnly />
					<TextInput label = 'Currency Name *' name = 'currencyName' defaultValue = { currencyNameDefault.value } style = '--area: 7 / span 1' required />
					<TextInput label = 'Currency Ticker *' name = 'currencyTicker' defaultValue = { currencyTickerDefault.value } style = '--area: 7 / span 1' required />
					<TextInput label = 'Block Explorer Url' name = 'blockExplorerUrl' defaultValue = { blockExplorerUrlDefault.value } style = '--area: 8 / span 1' />
					<TextInput label = 'Block Explorer Api Key' name = 'blockExplorerApiKey' defaultValue = { blockExplorerApiKeyDefault.value } style = '--area: 8 / span 1' />
				</div>
			</main>
			{ mutationState.value.state === 'rejected' ? <ErrorComponent text = { mutationState.value.error.message } containerStyle = { { margin: '0' } } /> : <></> }

			<footer class = 'grid' style = '--grid-cols: max-content 1fr max-content max-content; --gap-x: 1rem; --btn-text-size: 0.9rem'>
				{
					confirmRemoval.value ? (
						<div class = 'grid disclosure' style = '--gap-x: 1rem; --area: 2 / span 4'>
							<div style = '--area: 1 / span 3'>
								<p>You are about to remove this server permanently. Are you sure you want to proceed?</p>
							</div>
							<button type = 'button' class = 'btn btn--ghost' style = '--area: 2 / 2' onClick = { () => { confirmRemoval.value = false } } disabled = { mutationPending }>No</button>
							<button type = 'submit' value = 'remove' class = 'btn btn--destructive' style = '--area: 2 / 3' formNoValidate disabled = { mutationPending }>{ mutationPending ? 'Removing...' : 'Yes, Confirm Remove' }</button>
						</div>
					) : (
						<>
							<button type = 'submit' value = 'cancel' class = 'btn btn--ghost' style = '--area: 1 / 3' formNoValidate disabled = { mutationPending }>Cancel</button>
							<button type = 'submit' value = 'save' class = 'btn btn--primary' style = '--area: 1 / 4' disabled = { mutationPending }>{ mutationPending ? 'Saving RPC Connection...' : 'Save RPC Connection' }</button>
							{ defaultValues && onRemove ? (
								<button type = 'button' class = 'btn btn--ghost' style = '--area: 1 / 1; --btn-text-color: var(--negative-color)' onClick = { () => { confirmRemoval.value = true } } disabled = { mutationPending }><span class = 'grid' style = '--grid-cols: max-content 1fr; --gap-x: 0.5rem; --text-color: var(--negative-color)'><Trash /> Remove</span></button>
							) : <></> }
						</>
					)
				}
			</footer>
		</form>
	)
}

const RPC_URL_FETCH_DEBOUNCE = 600

const RpcUrlField = ({ defaultValue }: { defaultValue?: string }) => {
	const { rpcQuery, queryRpcInfo } = useQueryRpc()
	const inputRef = useRef<HTMLInputElement>(null)
	const timeout = useSignal<ReturnType<typeof setTimeout> | undefined>(undefined)

	const deferredQueryAnRpcUrl = (url: string) => {
		if (timeout.value) clearTimeout(timeout.value)
		if (!inputRef.current) return
		inputRef.current.setCustomValidity('')
		timeout.value = setTimeout(() => {
			queryRpcInfo(url.trim())
		}, RPC_URL_FETCH_DEBOUNCE)
	}

	useSignalEffect(() => {
		if (!inputRef.current) return
		switch (rpcQuery.value.state) {
			case 'inactive':
				if (defaultValue) inputRef.current.setCustomValidity('')
				return
			case 'pending':
				inputRef.current.setCustomValidity('')
				return
			case 'rejected':
				inputRef.current.setCustomValidity(rpcQuery.value.error.message)
				inputRef.current.reportValidity()
				return
			case 'resolved':
				inputRef.current.setCustomValidity('')
				return
		}
	})

	return <TextInput ref = { inputRef } label = 'RPC URL *' name = 'httpsRpc' defaultValue = { defaultValue } onInput = { (e) => deferredQueryAnRpcUrl(e.currentTarget.value) } statusIcon = { <AsyncStatusIcon state = { rpcQuery.value.state } /> } style = '--area: 1 / span 2' required autoComplete = 'off' autoFocus = { defaultValue === undefined } readOnly = { defaultValue !== undefined } />
}

const Trash = () => (
	<svg xmlns = 'http://www.w3.org/2000/svg' width = '1em' height = '1em' viewBox = '0 0 32 32'><path fill = 'currentColor' d = 'M15 4c-.522 0-1.06.185-1.438.563S13 5.478 13 6v1H7v2h1v16c0 1.645 1.355 3 3 3h12c1.645 0 3-1.355 3-3V9h1V7h-6V6c0-.522-.185-1.06-.563-1.438C20.06 4.186 19.523 4 19 4zm0 2h4v1h-4zm-5 3h14v16c0 .555-.445 1-1 1H11c-.555 0-1-.445-1-1zm2 3v11h2V12zm4 0v11h2V12zm4 0v11h2V12z' /></svg>
)
