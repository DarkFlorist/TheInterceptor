import { useRef } from 'preact/hooks'
import { ComponentChildren, JSX } from 'preact'
import { RpcEntry } from '../../types/rpc.js'
import { useSignal } from '@preact/signals'
import { setRpcList } from '../../background/storageVariables.js'


export const SetupNewRpc = ({ rpcEntries }: { rpcEntries: readonly RpcEntry[] }) => {
	const modalRef = useRef<HTMLDialogElement>(null)
	const formError = useSignal<string | undefined>(undefined)

	const verifyInputsAndSave = (event: Event) => {
		// Preact types can't accept a SubmitEvent type for dialog element's onSubmit so we do a check
		if (!(event instanceof SubmitEvent)) return

		// abort if dialog submitter was a cancel request
		if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'cancel') {
			modalRef.current?.close()
			return
		}

		// a form with `dialog` method within dialog element should have called this event
		if (event.target instanceof HTMLFormElement) {
			console.log('form??', event.target)
			const formData = new FormData(event.target)
			const newRpcEntry = {
				name: formData.get('name'),
				chainId: `0x${formData.get('chainId')}`,
				httpsRpc: formData.get('httpsRpc'),
				currencyName: formData.get('currencyName'),
				currencyLogoUri: '../../img/coins/ethereum.png',
				currencyTicker: 'ETH',
				minimized: true,
				primary: false,
				weth: '0x0'
			}

			const parsedRpcData = RpcEntry.safeParse(newRpcEntry)

			if (!parsedRpcData.success) {
				event.preventDefault()
				console.log('parse error', parsedRpcData)
				return
			}

			parsedRpcData.value satisfies RpcEntry

			setRpcList([...rpcEntries, parsedRpcData.value])
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
						<button type = 'submit' formNoValidate value = 'cancel' class = 'button button--ghost' aria-label = 'close' style = { { padding: '10px' } }>
							<span class = 'button-icon' style = { { fontSize: '1.5em' } }>&times;</span>
						</button>
					</header>
					<main class = 'dialog-main'>
						<div style = { { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 12 } }>
							<div style = { { width: 64, height: 64, aspectRatio: 'square', background: '#ffffff70' } }></div>
							<div class = 'fieldslist' >
								<InputField label = 'RPC URL' name = 'httpsRpc' required onInput = { clearErrors } />
								<InputField label = 'Network Name' name = 'name' required onInput = { clearErrors } />
								<InputField label = 'Chain ID' name = 'chainId' required onInput = { clearErrors } />
								<InputField label = 'Currency Name' name = 'currencyName' required onInput = { clearErrors } />
							</div>
						</div>
						{ formError.value ? <ErrorInfo>{formError.value}</ErrorInfo> : <></> }
					</main>
					<footer class = 'dialog-footer'>
						<button type = 'submit' formNoValidate value = 'cancel' class = 'button'>Cancel</button>
						<button type = 'submit' value = 'proceed' class = 'button is-primary'>Add</button>
					</footer>
				</form>
			</dialog>
		</>
	)
}

const ErrorInfo = ({ children }: { children: ComponentChildren }) => {
	return (
		<div style = { { background: 'var(--negative-color)', color: 'white', padding: '8px 16px', borderRadius: 6 } }>{children}</div>
	)
}

const InputField = ({ label, name, ...props }: JSX.HTMLAttributes<HTMLInputElement> & { label: string }) => {
	return (
		<div class = 'input-field'>
			<input id = { name } name = { name } placeholder = { label } { ...props } />
			<label for = { name }>{label}</label>
		</div>
	)
}
