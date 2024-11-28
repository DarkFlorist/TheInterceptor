import { createContext, type ComponentChildren } from 'preact'
import { useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useContext, useRef } from 'preact/hooks'
import { Network, JsonRpcProvider } from 'ethers'
import { AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { TextInput } from './TextField.js'
import { RpcEntry } from '../../types/rpc.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { getSettings } from '../../background/settings.js'
import { getChainName } from '../../utils/constants.js'
import { useRpcConnectionsList } from '../pages/SettingsView.js'
import { EthereumJSONRpcRequestHandler } from '../../simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthSimulateV1Params, EthSimulateV1Result } from '../../types/ethSimulate-types.js'
import { JsonRpcResponseError } from '../../utils/errors.js'
import { XMarkIcon } from './icons.js'

type ConfigureRpcContext = {
	queryRpcInfo: (url: string) => void
	rpcQuery: ReturnType<typeof useAsyncState<Network>>['value']
	resetRpcQuery: () => void
}

const ConfigureRpcContext = createContext<ConfigureRpcContext | undefined>(undefined)

const RpcQueryProvider = ({ children }: { children: ComponentChildren }) => {
	const { value: rpcQuery, waitFor, reset: resetRpcQuery } = useAsyncState<Network>()

	const checkServerAvailability = async (url: string) => {
		try {
			const provider = new JsonRpcProvider(url)
			return await provider.getNetwork()
		} catch {
			throw new Error('Server should be reachable')
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
		} catch (error) {
			let errorMessage = 'RPC eth_simulateV1 validation error'
			console.warn(errorMessage, error)
			if (error instanceof Error) errorMessage = `${ errorMessage } (${ error.message })`
			if (error instanceof JsonRpcResponseError) errorMessage = error.message
			throw new Error('The RPC server does not have a support for eth_simulateV1. The Interceptor requires this feature to function.')
		}
	}

	const queryRpcInfo = (url: string) => waitFor(async () => {
		const network = await checkServerAvailability(url)
		await validateEthSimulateSupport(url)
		return network
	})

	return <ConfigureRpcContext.Provider value = { { queryRpcInfo, rpcQuery, resetRpcQuery } }>{ children }</ConfigureRpcContext.Provider>
}

function useQueryRpc() {
	const context = useContext(ConfigureRpcContext)
	if (!context) throw new Error('useQueryRpc can only be used within children of RpcQueryProvider')
	return context
}

export const ConfigureRpcConnection = ({ rpcInfo }: { rpcInfo?: RpcEntry | undefined }) => {
	const rpcEntries = useRpcConnectionsList()
	const modalRef = useRef<HTMLDialogElement>(null)

	const showConfigurationModal = () => modalRef.current?.showModal()

	const cancelAndCloseModal = () => modalRef.current?.close()

	const saveRpcEntry = async (rpcEntry: RpcEntry) => {
		const { currentRpcNetwork } = await getSettings()

		await sendPopupMessageToBackgroundPage({
			method: 'popup_set_rpc_list',
			data: [rpcEntry].concat(rpcEntries.value.filter(entry => entry.httpsRpc !== rpcEntry.httpsRpc))
		})

		if (currentRpcNetwork.httpsRpc !== rpcEntry.httpsRpc) return
		console.warn(`Automatically switched to recently added or modified RPC (${ rpcEntry.httpsRpc })`)
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: rpcEntry })
	}

	const removeRpcEntryByUrl = async (url: string) => {
		const { currentRpcNetwork } = await getSettings()

		const reducedRpcEntries = rpcEntries.value.filter(entry => entry.httpsRpc !== url)

		await sendPopupMessageToBackgroundPage({ method: 'popup_set_rpc_list', data: reducedRpcEntries })

		// switch rpc when the active one is being removed
		if (url !== currentRpcNetwork.httpsRpc || reducedRpcEntries[0] === undefined) return
		console.warn('Switching RPC as a result of the removal of the currently active connection')

		// at least find a connection of the same chainId
		const rpcToSwitchTo = reducedRpcEntries.find(entry => entry.chainId === currentRpcNetwork.chainId) || reducedRpcEntries[0]
		sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveRpc', data: rpcToSwitchTo })
	}

	return (
		<RpcQueryProvider>
			{ rpcInfo
				? <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline'>Edit</button>
				: <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline' style = 'border-style: dashed'>+ New RPC Connection</button>
			}
			<dialog class = 'dialog' ref = { modalRef }>
				<ConfigureRpcForm defaultValues = { rpcInfo } onCancel = { cancelAndCloseModal } onSave = { saveRpcEntry } onRemove = { rpcEntries.value.length > 1 ? removeRpcEntryByUrl : undefined } />
			</dialog>
		</RpcQueryProvider>
	)
}

type ConfigureRpcFormProps = {
	defaultValues?: RpcEntry,
	onCancel: () => void
	onSave: (rpcEntry: RpcEntry) => void
	onRemove?: (rpcUrl: string) => void
}

const ConfigureRpcForm = ({ defaultValues, onCancel, onSave, onRemove }: ConfigureRpcFormProps) => {
	const confirmRemoval = useSignal(false)
	const { rpcQuery, resetRpcQuery } = useQueryRpc()

	const handleFormSubmit = (event: Event) => {
		// TODO: current version preact don't ship with SubmitEvent type
		if (!(event instanceof SubmitEvent)) return
		if (!(event.target instanceof HTMLFormElement)) return

		if (event.submitter instanceof HTMLButtonElement) {
			switch (event.submitter.value) {
				case 'cancel':
					onCancel()
					resetRpcQuery()
					event.target.reset()
					return

				case 'remove':
					if (defaultValues !== undefined) onRemove?.(defaultValues.httpsRpc)
					return

				case 'save':
					const formData = new FormData(event.target)
					const parsedData = parseRpcFormData(formData)

					if (parsedData.success) {
						onSave(parsedData.value)
						resetRpcQuery()
						event.target.reset()
						return
					}
			}
		}
	}

	const parseRpcFormData = (formData: FormData) => {
		const chainIdFromForm = formData.get('chainId')?.toString()
		const blockExplorerUrlForm = formData.get('blockExplorerUrl')?.toString()
		const blockExplorerApiKeyForm = formData.get('blockExplorerApiKey')?.toString()
		const isBlockExplorerDefined = blockExplorerUrlForm !== undefined && blockExplorerApiKeyForm !== undefined && blockExplorerUrlForm.length > 0 && blockExplorerApiKeyForm.length > 0
		const newRpcEntry = {
			name: formData.get('name')?.toString() || '',
			chainId: chainIdFromForm ? `0x${ BigInt(chainIdFromForm).toString(16) }` : '',
			httpsRpc: formData.get('httpsRpc')?.toString() || '',
			currencyName: formData.get('currencyName')?.toString() || '',
			currencyTicker: formData.get('currencyTicker')?.toString() || '',
			...isBlockExplorerDefined ? { blockExplorer: { apiUrl: blockExplorerUrlForm || '', apiKey: blockExplorerApiKeyForm } } : {},
			minimized: true,
			primary: false,
		}
		return RpcEntry.safeParse(newRpcEntry)
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
				<button type = 'submit' value = 'cancel' class = 'btn btn--ghost' aria-label = 'close' formNoValidate>
					<span class = 'button-icon' style = { { fontSize: '1.5em' } }>&times;</span>
				</button>
			</header>

			<main class = 'grid' style = '--gap-y: 0.5rem'>
				<p>Interceptor will automatically verify the RPC URL you provide and attempt to fill relevant information. Adjust the pre-populated details to your liking.</p>
				<div class = 'grid' style = '--grid-cols: 1fr 1fr; --gap-x: 1rem; --gap-y: 0' >
					<RpcUrlField defaultValue = { defaultValues?.httpsRpc } />
					<TextInput label = 'RPC Connection Name *' name = 'name' defaultValue = { networkNameDefault.value } style = '--area: 5 / span 1' required autoFocus />
					<TextInput label = 'Chain ID' name = 'chainId' style = '--area: 5 / span 1' defaultValue = { chainIdDefault.value } required readOnly />
					<TextInput label = 'Currency Name *' name = 'currencyName' defaultValue = { currencyNameDefault.value } style = '--area: 7 / span 1' required />
					<TextInput label = 'Currency Ticker *' name = 'currencyTicker' defaultValue = { currencyTickerDefault.value } style = '--area: 7 / span 1' required />
					<TextInput label = 'Block Explorer Url' name = 'blockExplorerUrl' defaultValue = { blockExplorerUrlDefault.value } style = '--area: 8 / span 1' />
					<TextInput label = 'Block Explorer Api Key' name = 'blockExplorerApiKey' defaultValue = { blockExplorerApiKeyDefault.value } style = '--area: 8 / span 1' />
				</div>
			</main>

			<footer class = 'grid' style = '--grid-cols: max-content 1fr max-content max-content; --gap-x: 1rem; --btn-text-size: 0.9rem'>
				{
					confirmRemoval.value ? (
						<div class = 'grid disclosure' style = '--gap-x: 1rem; --area: 2 / span 4'>
							<div style = '--area: 1 / span 3'>
								<p>You are about to remove this server permanently. Are you sure you want to proceed?</p>
							</div>
							<button type = 'button' class = 'btn btn--ghost' style = '--area: 2 / 2' onClick = { () => { confirmRemoval.value = false } }>No</button>
							<button type = 'submit' value = 'remove' class = 'btn btn--destructive' style = '--area: 2 / 3' formNoValidate>Yes, Confirm Remove</button>
						</div>
					) : (
						<>
							<button type = 'submit' value = 'cancel' class = 'btn btn--ghost' style = '--area: 1 / 3' formNoValidate>Cancel</button>
							<button type = 'submit' value = 'save' class = 'btn btn--primary' style = '--area: 1 / 4'>Save RPC Connection</button>
							{ defaultValues && onRemove ? (
								<button type = 'button' class = 'btn btn--ghost' style = '--area: 1 / 1; --btn-text-color: var(--negative-color)' onClick = { () => { confirmRemoval.value = true } }><span class = 'grid' style = '--grid-cols: max-content 1fr; --gap-x: 0.5rem; --text-color: var(--negative-color)'><Trash /> Remove</span></button>
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
		timeout.value = setTimeout(() => {
			queryRpcInfo(url)
		}, RPC_URL_FETCH_DEBOUNCE)
	}

	useSignalEffect(() => {
		if (!inputRef.current) return
		switch (rpcQuery.value.state) {
			case 'inactive':
				if (defaultValue) inputRef.current.setCustomValidity('')
				return
			case 'pending':
				inputRef.current.setCustomValidity('RPC is not yet verified')
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

	return <TextInput ref = { inputRef } label = 'RPC URL *' name = 'httpsRpc' defaultValue = { defaultValue } onInput = { (e) => deferredQueryAnRpcUrl(e.currentTarget.value) } statusIcon = { <StatusIcon state = { rpcQuery.value.state } /> } style = '--area: 1 / span 2' required autoComplete = 'off' autoFocus = { defaultValue === undefined } readOnly = { defaultValue !== undefined } />
}

export const StatusIcon = ({ state }: { state: AsyncStates }) => {
	switch (state) {
		case 'inactive': return <></>
		case 'pending': return <SpinnerIcon />
		case 'rejected': return <i style = {{ color: 'var(--negative-color)' }} ><XMarkIcon /></i>
		case 'resolved': return <CheckIcon />
	}
}

export const SpinnerIcon = () => (
	<svg class = 'spin' width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
		<circle cx = '8' cy = '8' r = '6.5' stroke = 'var(--text-color, currentColor)' stroke-opacity = '.5' stroke-width = '3' />
		<path d = 'M8 0a8 8 0 1 0 8 8h-3a5 5 0 1 1-5-5z' fill = 'var(--text-color, currentColor)' fill-opacity = '.4' />
	</svg>
)

export const CheckIcon = () => (
	<svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg' >
		<path d = 'M15 3L5.64686 12.5524L1 7.84615' stroke = 'var(--positive-color, currentColor)' strokeWidth = { 2 } />
	</svg>
)

export const Trash = () => (
	<svg xmlns = 'http://www.w3.org/2000/svg' width = '1em' height = '1em' viewBox = '0 0 32 32'><path fill = 'currentColor' d = 'M15 4c-.522 0-1.06.185-1.438.563S13 5.478 13 6v1H7v2h1v16c0 1.645 1.355 3 3 3h12c1.645 0 3-1.355 3-3V9h1V7h-6V6c0-.522-.185-1.06-.563-1.438C20.06 4.186 19.523 4 19 4zm0 2h4v1h-4zm-5 3h14v16c0 .555-.445 1-1 1H11c-.555 0-1-.445-1-1zm2 3v11h2V12zm4 0v11h2V12zm4 0v11h2V12z' /></svg>
)
