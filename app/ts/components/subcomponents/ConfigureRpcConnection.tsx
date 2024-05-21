import { createContext, type ComponentChildren } from 'preact'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useContext, useRef } from 'preact/hooks'
import { AsyncStates, useAsyncState } from '../../utils/preact-utilities.js'
import { TextInput } from './TextField.js'
import { RpcEntries, RpcEntry } from '../../types/rpc.js'
import { CHAIN_NAMES } from '../../utils/chainNames.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'

type ParsedData = { success: true, value: RpcEntry } | { message: string }

const parseData = (entry: RpcEntry) => {
	return { success: true, value: entry } satisfies ParsedData
}

type EthChainIdResponse = {
	id: string | null,
	jsonrpc: number,
	result: `0x${string}`
}

type ConfigureRpcContext = {
	rpcUrlQuery: ReturnType<typeof useAsyncState<EthChainIdResponse>>['value']
	rpcUrl: Signal<string>
}

const ConfigureRpcContext = createContext<ConfigureRpcContext | undefined>(undefined)

const ConfigureRpcProvider = ({ children }: { children: ComponentChildren, defaultRpcInfo?: RpcEntry }) => {
	const rpcUrl = useSignal('')
	const { value: rpcUrlQuery, waitFor, reset } = useAsyncState<EthChainIdResponse>()

	const fetchRpcInfo = (url: string) => waitFor(async () => {
		const requestBody = JSON.stringify({ method: 'eth_chainId', params: [], jsonrpc: '2.0' })
		const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody })
		if (!response.ok) throw new Error(`Could not connect to RPC server ${url}`)
		return await response.json()
	})

	useSignalEffect(() => {
		if (!rpcUrl.value) {
			reset()
			return
		}
		fetchRpcInfo(rpcUrl.value)
	})

	return <ConfigureRpcContext.Provider value = { { rpcUrlQuery, rpcUrl } }>{ children }</ConfigureRpcContext.Provider>
}

function useConfigureRpc() {
	const context = useContext(ConfigureRpcContext)
	if (!context) throw new Error('useConfigureRpc can only be used within children of ConfigureRpcProvider')
	return context
}

export const ConfigureRpcConnection = ({ rpcEntries, rpcInfo }: { rpcEntries: RpcEntries ,rpcInfo?: RpcEntry | undefined }) => {
	const modalRef = useRef<HTMLDialogElement>(null)

	const verifyInputsAndSave = (event: Event) => {
		// TODO: current version preact don't ship with SubmitEvent type
		if (!(event instanceof SubmitEvent)) return

		// abort if dialog submitter was a cancel request
		if (event.submitter instanceof HTMLButtonElement) {
			if (event.submitter.value === 'cancel') {
				// reset the form to it's previous state
				if (event.target instanceof HTMLFormElement) event.target.reset()
				modalRef.current?.close()
				return
			}

			if (event.submitter.value === 'remove') {
				// remove current rpc
				sendPopupMessageToBackgroundPage({
					method: 'popup_set_rpc_list',
					data: rpcEntries.filter(entry => entry.httpsRpc !== rpcInfo?.httpsRpc)
				})
				return
			}
		}

		// handle form validation and submission
		if (event.target instanceof HTMLFormElement) {
			const formData = new FormData(event.target)

			const newRpcEntry = {
				name: formData.get('name')?.toString() || '',
				chainId: BigInt(formData.get('chainId')?.toString() || ''),
				httpsRpc: formData.get('httpsRpc')?.toString() || '',
				currencyName: formData.get('currencyName')?.toString() || '',
				currencyTicker: formData.get('currencyTicker')?.toString() || '',
				minimized: true,
				primary: false,
			} satisfies RpcEntry

			const parsedRpcData = parseData(newRpcEntry)


			if (!parsedRpcData.success) {
				event.preventDefault()
				console.error('RPC Info Parse', parsedRpcData)
				return
			}

			sendPopupMessageToBackgroundPage({
				method: 'popup_set_rpc_list',
				data: rpcEntries.filter(entry => entry.httpsRpc !== parsedRpcData.value.httpsRpc).concat([parsedRpcData.value])
			})
		}
	}

	const showConfigurationModal = () => modalRef.current?.showModal()

	return (
		<ConfigureRpcProvider>
			{ rpcInfo
				? <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline'>Edit</button>
				: <button type = 'button' onClick = { showConfigurationModal } class = 'btn btn--outline' style = 'border-style: dashed'>+ New RPC Connection</button>
			}
			<dialog class = 'dialog' ref = { modalRef } onSubmit = { verifyInputsAndSave }>
				<ConfigureRpcForm defaultValues = { rpcInfo } />
			</dialog>
		</ConfigureRpcProvider>
	)
}

const ConfigureRpcForm = ({ defaultValues }: { defaultValues?: RpcEntry }) => {
	const confirmRemoval = useSignal(false)
	const { rpcUrlQuery } = useConfigureRpc()

	const chainIdDefault = useComputed(() => {
		if (rpcUrlQuery.value.state === 'resolved') return BigInt(rpcUrlQuery.value.value.result).toString()
		return defaultValues?.chainId?.toString() || ''
	})

	const networkNameDefault = useComputed(() => CHAIN_NAMES.get(chainIdDefault.value) || defaultValues?.name || '')

	const currencyTickerDefault = useComputed(() => {
		if (rpcUrlQuery.value.state === 'resolved') return defaultValues?.currencyTicker || 'ETH'
		return defaultValues?.currencyTicker || ''
	})

	const currencyNameDefault = useComputed(() => {
		if (rpcUrlQuery.value.state === 'resolved') return defaultValues?.currencyName || 'Ethers'
		return defaultValues?.currencyName || ''
	})

	return (
		<form method = 'dialog' class = 'grid' style = '--gap-y: 1.5rem'>
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
					<TextInput label = 'Network Name *' name = 'name' defaultValue = { networkNameDefault.value } style = '--area: 5 / span 1' required />
					<TextInput label = 'Chain ID' name = 'chainId' style = '--area: 5 / span 1' defaultValue = { chainIdDefault.value } required readOnly />
					<TextInput label = 'Currency Name *' name = 'currencyName' defaultValue = { currencyNameDefault.value } style = '--area: 7 / span 1' required />
					<TextInput label = 'Currency Ticker *' name = 'currencyTicker' defaultValue = { currencyTickerDefault.value } style = '--area: 7 / span 1' required />
				</div>
				<p style = '--text-color: gray'><small>* Fields marked with an asterisk (*) are required.</small></p>
			</main>

			<footer class = 'grid' style = '--grid-cols: max-content 1fr max-content max-content; --gap-x: 1rem; --btn-text-size: 0.9rem'>
				{
					confirmRemoval.value ? (
						<div class = 'grid disclosure' style = '--gap-x: 1rem; --area: 2 / span 4'>
							<div style = '--area: 1 / span 3'>
								<p>You are about to remove this server permanently. Are you sure you want to proceed?</p>
							</div>
							<button type = 'button' class = 'btn btn--ghost' style = '--area: 2 / 2' onClick = { () => confirmRemoval.value = false }>No</button>
							<button type = 'submit' value = 'remove' class = 'btn btn--destructive' style = '--area: 2 / 3' formNoValidate>Yes, Confirm Remove</button>
						</div>
					) : (
						<>
							<button type = 'submit' value = 'cancel' class = 'btn btn--ghost' style = '--area: 1 / 3' formNoValidate>Cancel</button>
							<button type = 'submit' value = 'proceed' class = 'btn btn--primary' style = '--area: 1 / 4'>Save RPC Connection</button>
							{ defaultValues ? (
								<button type = 'button' class = 'btn btn--ghost' style = '--area: 1 / 1; --btn-text-color: var(--negative-color)' onClick = { () => confirmRemoval.value = true }><span class = 'grid' style = '--grid-cols: max-content 1fr; --gap-x: 0.5rem; --text-color: var(--negative-color)'><Trash /> Remove</span></button>
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
	const { rpcUrlQuery, rpcUrl } = useConfigureRpc()
	const inputRef = useRef<HTMLInputElement>(null)
	const timeout = useSignal<ReturnType<typeof setTimeout> | undefined>(undefined)

	const verifyUrlFromInput = (event: Event) => {
		if (!(event.target instanceof HTMLInputElement)) return
		if (timeout.value) clearTimeout(timeout.value)
		const httpsRpc = event.target.value
		timeout.value = setTimeout(() => {
			rpcUrl.value = httpsRpc
		}, RPC_URL_FETCH_DEBOUNCE)
	}

	useSignalEffect(() => {
		if (!inputRef.current) return
		if (rpcUrlQuery.value.state === 'rejected') {
			inputRef.current.setCustomValidity('RPC URL should be reachable')
			inputRef.current.reportValidity()
			return
		}
		inputRef.current.setCustomValidity('')
	})

	return <TextInput ref = { inputRef } label = 'RPC URL *' name = 'httpsRpc' defaultValue = { defaultValue } onInput = { verifyUrlFromInput } statusIcon = { <StatusIcon state = { rpcUrlQuery.value.state } /> } style = '--area: 1 / span 2' autoFocus required />
}

export const StatusIcon = ({ state }: { state: AsyncStates }) => {
	switch (state) {
		case 'inactive': return <></>
		case 'pending': return <SpinnerIcon />
		case 'rejected': return <XMarkIcon />
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

export const XMarkIcon = () => (
	<svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg' >
		<path d = 'M15 1 8 8m0 0L1 1m7 7-7 7m7-7 7 7' stroke = 'var(--negative-color, currentColor)' strokeWidth = { 2 } />
	</svg>
)

export const Trash = () => (
	<svg xmlns = 'http://www.w3.org/2000/svg' width = '1em' height = '1em' viewBox = '0 0 32 32'><path fill = 'currentColor' d = 'M15 4c-.522 0-1.06.185-1.438.563S13 5.478 13 6v1H7v2h1v16c0 1.645 1.355 3 3 3h12c1.645 0 3-1.355 3-3V9h1V7h-6V6c0-.522-.185-1.06-.563-1.438C20.06 4.186 19.523 4 19 4zm0 2h4v1h-4zm-5 3h14v16c0 .555-.445 1-1 1H11c-.555 0-1-.445-1-1zm2 3v11h2V12zm4 0v11h2V12zm4 0v11h2V12z'/></svg>
)