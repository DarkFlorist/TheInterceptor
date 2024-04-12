import { useRef } from 'preact/hooks'
import { ComponentChildren, createContext } from 'preact'
import { RpcEntry } from '../../types/rpc.js'
import { useSignal } from '@preact/signals'

type RpcSetupContext = {
	formData: object
	isSettingUp: boolean
}
const RpcSetupContext = createContext<RpcSetupContext | undefined>(undefined)

export const RpcSetupProvider = ({ children }: { children: ComponentChildren }) => {
	const contextValue = {
		formData: {},
		isSettingUp: false
	}

	return (
		<RpcSetupContext.Provider value = { contextValue }>{ children }</RpcSetupContext.Provider>
	)
}


export const SetupNewRpc = () => {
	const modalRef = useRef<HTMLDialogElement>(null)
	const formError = useSignal<string | undefined>(undefined)

	const verifyInputsAndSave = (event: Event) => {
		// Preact types can't accept a SubmitEvent type for dialog element's onSubmit so we do a check
		if (!(event instanceof SubmitEvent)) return

		// abort if dialog submitter was a cancel request
		if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'cancel') return

		// a form with `dialog` method within dialog element should have called this event
		if (event.target instanceof HTMLFormElement) {
			const formData = new FormData(event.target)

			const formInput = RpcEntry.safeParse({
				name: formData.get('name'),
				chainId: formData.get('chainId'),
				httpsRpc: formData.get('httpsRpc'),
				currencyName: formData.get('currencyName'),
			})

			if (!formInput.success) {
				event.preventDefault()
				formError.value = 'Some fields are invalid'
			}
		}
	}

	const showSetupInterface = () => modalRef.current?.showModal()
	const clearErrors = () => { formError.value = undefined }

	return (
		<>
			<div style = { { marginLeft: 9, marginRight: 9 } }>
				<button onClick = { showSetupInterface } class = 'button button--inset'>+ New RPC Connection</button>
			</div>
			<dialog class = 'dialog' ref = { modalRef } onSubmit = { verifyInputsAndSave } style = { { width: 'calc(100% - 2em)', maxWidth: '36em' } }>
				<form method = 'dialog' >
					<header class = 'dialog-header'>
						<span style = { { fontWeight: 'bold' } }>Add RPC Connection</span>
						<button type = 'submit' value = 'cancel' class = 'button button--ghost' aria-label = 'close' style = { { padding: '10px' } }>
							<span class = 'button-icon' style = { { fontSize: '1.5em' } }>&times;</span>
						</button>
					</header>
					<main class = 'dialog-main'>
						<div class = 'fields-grid'>
							<label for = 'rpc_name'>Network Name:</label>
							<input id = 'rpc_name' type = 'text' name = 'name' onInput = { clearErrors } class = 'input'/>
							<label for = 'rpc_chain_id'>Chain ID:</label>
							<input id = 'rpc_chain_id' type = 'text' name = 'chainId' onInput = { clearErrors } class = 'input' />
							<label for = 'rpc_url'>RPC URL:</label>
							<input id = 'rpc_url'  type = 'text' name = 'httpsRpc' onInput = { clearErrors } class = 'input'/>
							<label for = 'rpc_currency'>Currency Name:</label>
							<input id = 'rpc_currency' type = 'text' name = 'currencyName' onInput = { clearErrors }  class = 'input'/>
						</div>
						{ formError.value ? <ErrorInfo>{formError.value}</ErrorInfo> : <></> }
					</main>
					<footer class = 'dialog-footer'>
						<button type = 'submit' value = 'cancel' class = 'button'>Cancel</button>
						<button type = 'submit' value = 'proceed' class = 'button is-primary'>Add</button>
					</footer>
				</form>
			</dialog>
		</>
	)
}

const ErrorInfo = ({ children }: { children: ComponentChildren }) => {
	return (
	<div style = {{ background: 'var(--negative-color)', color: 'white', padding: '8px 16px', borderRadius: 6 }}>{children}</div>
	)
}
